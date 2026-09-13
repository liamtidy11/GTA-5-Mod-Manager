const fs = require("fs");
const path = require("path");

const CHANCE_MIN = 0;
const CHANCE_MAX = 100;

function lineAt(text, index) {
  if (index < 0) return 1;
  return String(text || "").slice(0, index).split(/\r?\n/).length;
}

function tagStackWellFormed(xml) {
  const stack = [];
  const re = /<!--[\s\S]*?-->|<([A-Za-z][\w:-]*)([^>]*)>|<\/([A-Za-z][\w:-]*)>/g;
  let match;
  while ((match = re.exec(xml))) {
    if (match[0].startsWith("<!--")) continue;
    if (match[3]) {
      const expected = stack.pop();
      if (expected !== match[3]) {
        return { ok: false, line: lineAt(xml, match.index), detail: `Mismatched </${match[3]}>.` };
      }
      continue;
    }
    const name = match[1];
    const attrs = match[2] || "";
    if (/\/\s*$/.test(attrs) || /\/\s*>$/.test(match[0])) continue;
    stack.push(name);
  }
  if (stack.length) {
    return { ok: false, line: lineAt(xml, xml.length - 1), detail: `Unclosed <${stack[stack.length - 1]}>.` };
  }
  return { ok: true };
}

function validateChanceAttributes(xml) {
  const issues = [];
  const re = /\bchance\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = re.exec(xml))) {
    const raw = match[1];
    const line = lineAt(xml, match.index);
    if (!String(raw).trim()) {
      issues.push({
        line,
        key: "chance",
        value: raw,
        detail: `inventory.xml line ${line}: chance is blank.`,
      });
      continue;
    }
    if (!/^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
      issues.push({
        line,
        key: "chance",
        value: raw,
        detail: `inventory.xml line ${line}: chance "${raw}" is not a number.`,
      });
      continue;
    }
    const num = Number(raw);
    if (num < CHANCE_MIN || num > CHANCE_MAX) {
      issues.push({
        line,
        key: "chance",
        value: raw,
        detail: `inventory.xml line ${line}: chance ${raw} is outside ${CHANCE_MIN}–${CHANCE_MAX}.`,
      });
    }
  }
  return issues;
}

function validateXmlText(xml) {
  const text = String(xml || "");
  const malformed = tagStackWellFormed(text);
  const chances = validateChanceAttributes(text);
  return {
    ok: malformed.ok && !chances.length,
    malformed: malformed.ok ? null : malformed,
    chances,
    issues: [...(malformed.ok ? [] : [malformed]), ...chances],
  };
}

function validateFile(dutyPath) {
  const file = path.join(dutyPath || "", "lspdfr", "data", "inventory.xml");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: true, missing: true, file, issues: [] };
  }
  return { ...validateXmlText(text), file, text, missing: false };
}

function repairEmptyChance(xml) {
  return String(xml || "").replace(/\s+chance="\s*"/g, "");
}

function repairFile(dutyPath) {
  const result = validateFile(dutyPath);
  if (result.missing || !result.file) return { changed: false, ...result };
  const next = repairEmptyChance(result.text);
  if (next === result.text) return { changed: false, ...validateXmlText(result.text), file: result.file };
  const after = validateXmlText(next);
  if (!after.ok) return { changed: false, ...after, file: result.file, refused: true };
  fs.writeFileSync(result.file, next, "utf8");
  return { changed: true, ...after, file: result.file };
}

module.exports = {
  CHANCE_MIN,
  CHANCE_MAX,
  validateXmlText,
  validateFile,
  repairEmptyChance,
  repairFile,
};
