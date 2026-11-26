// Validates a course against the agentschools/course-spec rules.
// Self-contained: no dependencies. Reuses the JSON Schemas from
// ../reference/course-spec/schemas/.
//
// Usage: node check.mjs [courseDir]

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const courseDir = process.argv[2] || here;
const schemasDir = join(here, "..", "reference", "course-spec", "schemas");

const errors = [];
const checks = [];

function fail(msg) {
  errors.push(msg);
}
function pass(msg) {
  checks.push(msg);
}

// --- minimal YAML subset: flat keys, block scalars (|, |-, >), nested maps ---
function parseScalar(raw) {
  let val = raw.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return {};
  const lines = m[1].split("\n");

  const blockScalar = (indent) => {
    const out = [];
    while (lines.length && lines[0].startsWith(" ".repeat(indent))) {
      out.push(lines.shift().slice(indent));
    }
    return out.join("\n").trim();
  };

  const parseBlock = (indent) => {
    const obj = {};
    while (lines.length) {
      const line = lines[0];
      if (line.trim() === "") {
        lines.shift();
        continue;
      }
      const cur = line.match(/^ */)[0].length;
      if (cur < indent) break;
      if (cur > indent) {
        lines.shift();
        continue;
      }
      lines.shift();
      const kv = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/);
      if (!kv) continue;
      const key = kv[1];
      const rest = line.slice(kv[0].length);
      if (rest.trim() === "|" || rest.trim() === "|-" || rest.trim() === ">") {
        obj[key] = blockScalar(indent + 2);
      } else if (rest.trim() === "") {
        obj[key] = parseBlock(indent + 2);
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  };

  return parseBlock(0);
}

// --- minimal JSON Schema validator for the fields this course uses ---
function validate(schema, value, path, label) {
  if (!schema) return;
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail(`${label} ${path}: expected object`);
      return;
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          fail(`${label} ${path || "(root)"}: unknown key "${key}"`);
        }
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validate(subschema, value[key], path ? `${path}.${key}` : key, label);
      }
    }
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") {
      fail(`${label} ${path}: expected string`);
      return;
    }
    if (schema.minLength && value.length < schema.minLength) {
      fail(`${label} ${path}: shorter than ${schema.minLength}`);
    }
    if (schema.maxLength && value.length > schema.maxLength) {
      fail(`${label} ${path}: longer than ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      fail(`${label} ${path}: does not match pattern ${schema.pattern}`);
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      fail(`${label} ${path}: expected array`);
    }
  }
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INTERVIEW_SLUG = "interview";

function exerciseSlugFromFilename(filename) {
  return filename.replace(/\.md$/, "").replace(/^\d+[-_]/, "");
}

// Natural filename order, so "2-x.md" sorts before "10-y.md".
function compareExerciseFilenames(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

// The first `# ` heading outside a fenced code block, if any.
function titleFromMarkdown(markdown) {
  let fence = undefined;
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker === fence) fence = undefined;
      continue;
    }
    const heading = !fence && line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (heading) return heading[1];
  }
  return undefined;
}

const courseSchema = JSON.parse(
  readFileSync(join(schemasDir, "course-frontmatter.schema.json"), "utf8")
);
const exerciseSchema = JSON.parse(
  readFileSync(join(schemasDir, "exercise-frontmatter.schema.json"), "utf8")
);

// --- COURSE.md ---
const courseText = readFileSync(join(courseDir, "COURSE.md"), "utf8");
const courseFm = parseFrontmatter(courseText);
const courseBody = courseText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
validate(courseSchema, courseFm, "", "COURSE.md");
if (Object.keys(courseFm).length) pass("COURSE.md frontmatter parsed");
if (courseFm.name && NAME_PATTERN.test(courseFm.name)) pass(`name valid: ${courseFm.name}`);
if (!courseBody.trim()) fail("COURSE.md has no body after frontmatter");
if (!/^#\s+.+/m.test(courseBody)) fail("COURSE.md body has no # title");

// --- exercises ---
const exDir = join(courseDir, "exercises");
const files = readdirSync(exDir).filter((f) => f.endsWith(".md")).sort(compareExerciseFilenames);
if (files.length === 0) fail("exercises/ has no Markdown files");

const slugs = [];
for (const file of files) {
  const slug = exerciseSlugFromFilename(file);
  slugs.push(slug);
  if (!NAME_PATTERN.test(slug)) fail(`exercise slug invalid: ${slug}`);
  const text = readFileSync(join(exDir, file), "utf8");
  const exFm = parseFrontmatter(text);
  validate(exerciseSchema, exFm, "", `exercises/${file}`);
  if (Object.keys(exFm).length) pass(`exercises/${file} frontmatter parsed`);
  const title = titleFromMarkdown(text);
  if (!title) fail(`exercises/${file} has no # title heading`);
  if (slug === INTERVIEW_SLUG && (title || "").toLowerCase() !== "interview") {
    fail(`exercises/${file} interview title should be "Interview", got "${title}"`);
  }
}

if (slugs.includes(INTERVIEW_SLUG)) pass("has interview exercise");
else fail("missing interview exercise (slug 'interview')");

const dupes = slugs.filter((s, idx) => slugs.indexOf(s) !== idx);
for (const d of dupes) fail(`duplicate exercise slug: ${d}`);

const interviewFile = files.find((f) => exerciseSlugFromFilename(f) === INTERVIEW_SLUG);
if (interviewFile && files[0] !== interviewFile) {
  fail(`interview (${interviewFile}) must be first by filename order; first is ${files[0]}`);
}

if (errors.length === 0) {
  console.log(`PASS: ${checks.length} checks OK, ${files.length} exercises: ${slugs.join(", ")}`);
} else {
  console.error(`FAIL: ${errors.length} problem(s)`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
