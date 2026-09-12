const path = require("path");

// Treats extracted archives as untrusted. Two jobs:
//   1. Reject directory-traversal entries (paths that escape the staging root).
//   2. Surface executable / script content so it is never run automatically.
//
// This does NOT execute anything. It only classifies and validates paths.

// Extensions that must be explicitly surfaced to the user and never auto-run.
const EXECUTABLE_EXT = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".msi",
  ".scr",
  ".com",
  ".jar",
  ".sh",
]);

function normSlash(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

// True if a relative path tries to escape its root (../, absolute, or drive).
function isTraversal(rel) {
  const p = normSlash(rel);
  if (p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return true;
  return p
    .split("/")
    .some((seg) => seg === ".." );
}

// Confirm that resolving rel under root stays inside root. Defense in depth on
// top of isTraversal, and mirrors paths.safeJoin used at write time.
function staysInside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, normSlash(rel));
  const baseNorm = base.toLowerCase();
  const fullNorm = full.toLowerCase();
  return fullNorm === baseNorm || fullNorm.startsWith(baseNorm + path.sep.toLowerCase());
}

function isExecutable(rel) {
  return EXECUTABLE_EXT.has(path.extname(normSlash(rel)).toLowerCase());
}

// Validates a list of staged relative paths. Returns:
//   { ok, traversal: [...], executables: [...] }
// ok is false when any traversal entry exists; executables are informational
// (surfaced to the user, never auto-run).
function validateEntries(files, stagingRoot = null) {
  const traversal = [];
  const executables = [];
  for (const rel of files) {
    if (isTraversal(rel) || (stagingRoot && !staysInside(stagingRoot, rel))) {
      traversal.push(normSlash(rel));
      continue;
    }
    if (isExecutable(rel)) executables.push(normSlash(rel));
  }
  return { ok: traversal.length === 0, traversal, executables };
}

module.exports = {
  EXECUTABLE_EXT,
  isTraversal,
  staysInside,
  isExecutable,
  validateEntries,
};
