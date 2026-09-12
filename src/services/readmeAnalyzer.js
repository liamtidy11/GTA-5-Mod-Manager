const fs = require("fs");
const path = require("path");
const modKnowledge = require("./modKnowledge");

// Reads staged documentation as untrusted text. Never executes, never writes
// to Duty, never follows README instructions. Evidence only.

const DOC_NAME = /^(readme|read[\s-]?me|install|installation|requirements?|changelog|how[\s-]?to|instructions)/i;
const DOC_EXT = /\.(txt|md|rtf|nfo)$/i;
const MAX_BYTES = 20_000;
const MAX_DOCS = 6;

const REQUIRED_RE = /\b(requires?|required|requirements?|dependenc(?:y|ies)|needs?|you need|must have|install first)\b/i;
const OPTIONAL_RE = /\boptional\b/i;
const RECOMMENDED_RE = /\brecommended\b/i;
const NEGATIVE_RE = /\b(not required|no dependenc|doesn't require|does not require)\b/i;

const VERSION_PATTERNS = [
  /(>=|>|<=|<|=)\s*v?(\d+(?:\.\d+){0,3})\b/i,
  /\bv?(\d+(?:\.\d+){1,3})\s*(?:or newer|and (?:above|newer|later))\b/i,
  /\bv?(\d+(?:\.\d+){1,3})\+/,
];

function compact(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isDocFile(rel) {
  const base = path.basename(String(rel || "").replace(/\\/g, "/"));
  return DOC_NAME.test(base) && DOC_EXT.test(base);
}

function buildCatalog(database) {
  const terms = [];
  for (const entry of (database && database.mods) || []) {
    const labels = [entry.name, entry.id, ...(entry.aliases || [])];
    for (const dll of (entry.recognition && entry.recognition.dllNames) || []) {
      labels.push(dll.replace(/\.(dll|asi|exe)$/i, ""));
    }
    const unique = [...new Set(labels.map((l) => String(l || "").trim()).filter(Boolean))];
    unique.sort((a, b) => b.length - a.length);
    for (const label of unique) {
      if (compact(label).length < 3) continue;
      terms.push({ label, modId: entry.id, name: entry.name, compact: compact(label) });
    }
  }
  terms.sort((a, b) => b.label.length - a.label.length);
  return terms;
}

function kindFor(line) {
  if (NEGATIVE_RE.test(line)) return "UNKNOWN";
  const optional = OPTIONAL_RE.test(line);
  const recommended = RECOMMENDED_RE.test(line);
  const required = REQUIRED_RE.test(line);
  if (optional && !required) return "OPTIONAL";
  if (recommended && !required) return "RECOMMENDED";
  if (required && optional) return "OPTIONAL";
  if (required && recommended) return "RECOMMENDED";
  if (required) return "REQUIRED";
  return "UNKNOWN";
}

function versionFor(line) {
  if (/\b(latest|newest|most recent)\b/i.test(line) && !/\d+\.\d+/.test(line)) {
    return "UNKNOWN";
  }
  const operator = String(line || "").match(/(>=|>|<=|<|=)\s*v?(\d+(?:\.\d+){0,3})\b/i);
  if (operator) return `${operator[1]} ${operator[2]}`;
  for (const re of VERSION_PATTERNS.slice(1)) {
    const match = line.match(re);
    if (match) return `>= ${match[1]}`;
  }
  return "";
}

function findTerm(line, terms) {
  const compactLine = compact(line);
  for (const term of terms) {
    const escaped = term.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (term.label.length >= 3 && new RegExp(`\\b${escaped}\\b`, "i").test(line)) {
      return term;
    }
    if (term.compact.length >= 6 && compactLine.includes(term.compact)) return term;
  }
  return null;
}

function snippet(line, limit = 80) {
  return String(line || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function collectTexts(scan) {
  const texts = [];
  if (scan && scan.readmeText) texts.push({ file: "README", text: String(scan.readmeText).slice(0, MAX_BYTES) });
  const files = (scan && scan.files) || [];
  let count = 0;
  for (const file of files) {
    const rel = typeof file === "string" ? file : file.rel;
    if (!isDocFile(rel)) continue;
    if (count >= MAX_DOCS) break;
    if (!scan.root) continue;
    const abs = path.join(scan.root, String(rel).split("/").join(path.sep));
    try {
      const text = fs.readFileSync(abs, "utf8").slice(0, MAX_BYTES);
      texts.push({ file: rel, text });
      count += 1;
    } catch {
      /* unreadable doc is ignored */
    }
  }
  return texts;
}

function analyze(scan, { database = null } = {}) {
  const db = database || modKnowledge.load();
  const terms = buildCatalog(db);
  const dependencies = [];
  const seen = new Set();

  for (const doc of collectTexts(scan)) {
    for (const line of String(doc.text).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length < 4 || trimmed.length > 400) continue;
      const term = findTerm(trimmed, terms);
      if (!term) continue;
      const kind = kindFor(trimmed);
      const requirement = versionFor(trimmed);
      const hasPhrase =
        REQUIRED_RE.test(trimmed) ||
        OPTIONAL_RE.test(trimmed) ||
        RECOMMENDED_RE.test(trimmed) ||
        NEGATIVE_RE.test(trimmed);
      if (!hasPhrase && !requirement) continue;
      const key = `${term.modId}|${kind}|${requirement}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({
        name: term.name,
        modId: term.modId,
        kind,
        source: "README",
        confidence: "MEDIUM",
        evidence: snippet(trimmed),
        version: requirement,
        file: doc.file,
      });
    }
  }

  return { dependencies };
}

module.exports = { analyze, buildCatalog, kindFor, versionFor, isDocFile };
