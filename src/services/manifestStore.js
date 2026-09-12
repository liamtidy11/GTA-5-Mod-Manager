const fs = require("fs");
const path = require("path");
const { SCHEMA_VERSION, validateManifest, normalizeListed } = require("./manifestValidate");

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
  const payload = { ...manifest, schemaVersion: manifest.schemaVersion || SCHEMA_VERSION };
  fs.writeFileSync(manifestPath(dataDir, payload.id), JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function read(dataDir, id) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(dataDir, id), "utf8"));
    const checked = validateManifest(raw);
    return checked.manifest || raw;
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
      const raw = JSON.parse(fs.readFileSync(path.join(manifestsDir(dataDir), name), "utf8"));
      out.push(normalizeListed(raw, name));
    } catch {
      out.push(normalizeListed(null, name));
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
  SCHEMA_VERSION,
  manifestsDir,
  manifestPath,
  write,
  read,
  list,
  remove,
  ownersOf,
};
