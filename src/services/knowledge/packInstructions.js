const fs = require("fs");
const path = require("path");

// Reads install-looking text from a staged pack. Evidence only.

const DOC_NAME = /^(readme|read[\s-]?me|install|installation|requirements?|getting[\s-]?started|how[\s-]?to|instructions)/i;
const DOC_EXT = /\.(txt|md|rtf|nfo|html?)$/i;
const MAX_BYTES = 24_000;
const MAX_DOCS = 8;
const MAX_STEPS = 12;

function isDocFile(rel) {
  const base = path.basename(String(rel || "").replace(/\\/g, "/"));
  return DOC_NAME.test(base) && DOC_EXT.test(base);
}

function readDocs(scan) {
  const texts = [];
  if (scan && scan.readmeText) texts.push({ file: "README", text: String(scan.readmeText).slice(0, MAX_BYTES) });
  const root = scan && scan.root;
  const files = (scan && (scan.usableFiles || scan.files)) || [];
  for (const file of files) {
    const rel = typeof file === "string" ? file : file.rel;
    if (!isDocFile(rel) || texts.length >= MAX_DOCS) continue;
    if (texts.some((row) => row.file === rel)) continue;
    if (!root) continue;
    try {
      const text = fs.readFileSync(path.join(root, rel), "utf8").slice(0, MAX_BYTES);
      if (text.trim()) texts.push({ file: rel, text });
    } catch {
      /* unreadable doc */
    }
  }
  return texts;
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractSteps(text) {
  const clean = /<[a-z][\s\S]*>/i.test(text) ? stripHtml(text) : String(text || "");
  const lines = clean.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const steps = [];
  for (const line of lines) {
    const numbered = line.match(/^(?:step\s*)?\d{1,2}[.)\-]\s+(.+)/i);
    const bullet = line.match(/^[-*•]\s+(.+)/);
    const body = ((numbered && numbered[1]) || (bullet && bullet[1]) || "").trim();
    if (!body || body.length < 8 || body.length > 280) continue;
    if (!/\b(install|extract|drag|copy|place|put|drop|require|need|folder|plugin|duty|gta|lspdfr|rage|dll)\b/i.test(body)) {
      continue;
    }
    steps.push(body.replace(/\s+/g, " "));
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

function urlsFromText(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s)<>"'\\]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:]+$/, "")))];
}

function extract(scan) {
  const docs = readDocs(scan);
  const steps = [];
  const urls = [];
  for (const doc of docs) {
    for (const step of extractSteps(doc.text)) {
      if (!steps.includes(step)) steps.push(step);
    }
    for (const url of urlsFromText(doc.text)) urls.push(url);
  }
  return {
    docs: docs.map((d) => d.file),
    steps: steps.slice(0, MAX_STEPS),
    urls: [...new Set(urls)].slice(0, 6),
  };
}

module.exports = { extract, extractSteps, urlsFromText, stripHtml, isDocFile };
