const fs = require("fs");
const path = require("path");

function cacheDir(root) {
  return path.join(root, "cache");
}

function metaPath(root) {
  return path.join(cacheDir(root), "meta.json");
}

function emptyMeta() {
  return { schemaVersion: 1, updatedAt: null, provider: "", stale: true };
}

function loadMeta(root) {
  try {
    return { ...emptyMeta(), ...JSON.parse(fs.readFileSync(metaPath(root), "utf8")) };
  } catch {
    return emptyMeta();
  }
}

function writeCache(root, { provider = "LOCAL_CATALOG", payload = {}, now = new Date().toISOString() } = {}) {
  fs.mkdirSync(cacheDir(root), { recursive: true });
  const meta = { schemaVersion: 1, updatedAt: now, provider, stale: false };
  fs.writeFileSync(metaPath(root), `${JSON.stringify(meta, null, 2)}\n`);
  fs.writeFileSync(path.join(cacheDir(root), "payload.json"), `${JSON.stringify(payload, null, 2)}\n`);
  return meta;
}

function readCache(root, { ttlMs = 24 * 60 * 60 * 1000, nowMs = Date.now() } = {}) {
  const meta = loadMeta(root);
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(cacheDir(root), "payload.json"), "utf8"));
  } catch {
    payload = null;
  }
  const age = meta.updatedAt ? nowMs - Date.parse(meta.updatedAt) : Number.POSITIVE_INFINITY;
  const stale = !meta.updatedAt || !Number.isFinite(age) || age > ttlMs;
  return { meta: { ...meta, stale }, payload, stale, lastUpdated: meta.updatedAt };
}

module.exports = { cacheDir, writeCache, readCache, loadMeta };
