const fs = require("fs");
const path = require("path");

// Per-install manifests for Smart Install v1. Each manifest records exactly
// which files a mod added/replaced, their hashes, and any backups, so an
// install can be rolled back or uninstalled precisely.
//
// Manifests live under <dataDir>/manifests/<id>.json, where dataDir is kept
// OUTSIDE the clean Online install (in production: app.getPath("userData")/data).

function manifestsDir(dataDir) {
  return path.join(dataDir, "manifests");
}

function manifestPath(dataDir, id) {
  return path.join(manifestsDir(dataDir), `${id}.json`);
}

function ensureDir(dataDir) {
  fs.mkdirSync(manifestsDir(dataDir), { recursive: true });
}

function write(dataDir, manifest) {
  ensureDir(dataDir);
  fs.writeFileSync(manifestPath(dataDir, manifest.id), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

function read(dataDir, id) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dataDir, id), "utf8"));
  } catch {
    return null;
  }
}

function list(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(manifestsDir(dataDir));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".json")) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(manifestsDir(dataDir), name), "utf8")));
    } catch {
      /* skip unreadable manifest */
    }
  }
  return out.sort((a, b) => String(b.installedAt || "").localeCompare(String(a.installedAt || "")));
}

function remove(dataDir, id) {
  try {
    fs.rmSync(manifestPath(dataDir, id), { force: true });
  } catch {
    /* ignore */
  }
}

function normDest(rel) {
  return String(rel || "").replace(/\\/g, "/").toLowerCase();
}

// Which installed mods (other than excludeId) also own a given destination.
function ownersOf(dataDir, destRel, excludeId = null) {
  const needle = normDest(destRel);
  return list(dataDir).filter(
    (m) =>
      m.id !== excludeId &&
      (m.files || []).some((f) => normDest(f.destination) === needle)
  );
}

module.exports = {
  manifestsDir,
  manifestPath,
  write,
  read,
  list,
  remove,
  ownersOf,
};
