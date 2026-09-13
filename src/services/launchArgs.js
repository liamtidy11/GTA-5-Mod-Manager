const fs = require("fs");
const path = require("path");

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function tokenize(text) {
  return String(text || "")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isFlag(token) {
  return /^--?[A-Za-z]/.test(String(token || ""));
}

function flagKey(token) {
  return String(token || "")
    .replace(/^--?/, "")
    .toLowerCase();
}

function dedupeLaunchFlags(tokens) {
  const seen = new Set();
  const out = [];
  for (const token of tokens || []) {
    if (isFlag(token)) {
      const key = flagKey(token);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(token);
  }
  return out;
}

function findDuplicateFlags(texts) {
  const counts = new Map();
  for (const text of texts || []) {
    for (const token of tokenize(text)) {
      if (!isFlag(token)) continue;
      const key = flagKey(token);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([flag, count]) => ({ flag: `-${flag}`, count }));
}

function stripFlag(text, flag = "-nobattleye") {
  const key = flagKey(flag);
  return tokenize(text)
    .filter((token) => !(isFlag(token) && flagKey(token) === key))
    .join("\n");
}

function dutyLaunchTexts(dutyPath) {
  if (!dutyPath) return [];
  return [
    readText(path.join(dutyPath, "commandline.txt")),
    readText(path.join(dutyPath, "args.txt")),
  ];
}

function findDutyDuplicateFlags(dutyPath) {
  return findDuplicateFlags(dutyLaunchTexts(dutyPath));
}

function writeIfChanged(file, text) {
  const next = String(text || "").trim();
  try {
    if (!next) {
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
      return true;
    }
    fs.writeFileSync(file, `${next}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function removeFlagFromFile(file, flag = "-nobattleye") {
  if (!file) return false;
  return writeIfChanged(file, stripFlag(readText(file), flag));
}

module.exports = {
  tokenize,
  isFlag,
  flagKey,
  dedupeLaunchFlags,
  findDuplicateFlags,
  findDutyDuplicateFlags,
  dutyLaunchTexts,
  stripFlag,
  removeFlagFromFile,
};
