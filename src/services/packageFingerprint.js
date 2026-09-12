const fs = require("fs");
const path = require("path");
const { hashFileSync, hashString } = require("./hashUtil");

// SHA-256 fingerprint of a dropped archive or staged folder. Read-only.

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  }
  return out.sort();
}

function fingerprintPath(target) {
  if (!target) return "";
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) return hashFileSync(target);
    const rows = [];
    for (const rel of walkFiles(target)) {
      const abs = path.join(target, rel.split("/").join(path.sep));
      try {
        const info = fs.statSync(abs);
        rows.push(`${rel}\t${info.size}\t${hashFileSync(abs)}`);
      } catch {
        rows.push(`${rel}\tmissing`);
      }
    }
    return hashString(rows.join("\n"));
  } catch {
    return "";
  }
}

module.exports = { fingerprintPath, walkFiles };
