const fs = require("fs");
const path = require("path");

// Exports/imports MANAGER-OWNED metadata only: profiles, snapshot metadata +
// config blobs, mod-knowledge overrides, manifests, history, and settings.
// It never bundles the GTA install and never writes into Duty on import until
// the user reviews a restore plan.

const SCHEMA_VERSION = 1;

function copyDir(src, dest, filter) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true, filter: filter || (() => true) });
  return true;
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function countEntries(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

// Snapshots can carry large per-version payloads. Those are excluded from a
// metadata backup unless includePayloads is set.
function snapshotFilter(includePayloads) {
  return (src) => {
    if (includePayloads) return true;
    return !/[\\/]payloads([\\/]|$)/i.test(src);
  };
}

function exportBackup(context = {}, destDir, options = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const contents = [];

  if (copyDir(context.profileRoot, path.join(destDir, "profiles"))) {
    contents.push({ kind: "profiles", count: countEntries(context.profileRoot) });
  }
  if (copyDir(context.snapshotRoot, path.join(destDir, "snapshots"), snapshotFilter(options.includePayloads))) {
    contents.push({ kind: "snapshots", count: countEntries(context.snapshotRoot), payloads: Boolean(options.includePayloads) });
  }
  const knowledgeRoot = path.join(context.dataDir || "", "mod-knowledge");
  if (copyDir(knowledgeRoot, path.join(destDir, "mod-knowledge"))) {
    contents.push({ kind: "mod-knowledge" });
  }
  if (copyDir(path.join(context.dataDir || "", "manifests"), path.join(destDir, "manifests"))) {
    contents.push({ kind: "manifests", count: countEntries(path.join(context.dataDir, "manifests")) });
  }
  const historyDest = path.join(destDir, "history");
  let history = false;
  history = copyFile(path.join(context.dataDir || "", "smart-audit.jsonl"), path.join(historyDest, "smart-audit.jsonl")) || history;
  history = copyFile(path.join(context.dataDir || "", "smart-metrics.json"), path.join(historyDest, "smart-metrics.json")) || history;
  if (history) contents.push({ kind: "history" });

  if (copyFile(path.join(context.userData || "", "config.json"), path.join(destDir, "settings.json"))) {
    contents.push({ kind: "settings" });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: context.appVersion || "0.0.0",
    includesPayloads: Boolean(options.includePayloads),
    contents,
  };
  fs.writeFileSync(path.join(destDir, "backup.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function readBackup(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8"));
    if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || !Array.isArray(manifest.contents)) {
      return { valid: false, errors: ["backup.json is missing, malformed, or a different schema version."] };
    }
    return { valid: true, manifest };
  } catch (error) {
    return { valid: false, errors: [`backup.json could not be read: ${error.message}`] };
  }
}

// Read-only: describes what an import would restore. Never writes Duty.
function planImport(dir, context = {}) {
  const check = readBackup(dir);
  if (!check.valid) return { valid: false, errors: check.errors };
  const steps = [];
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  if (has("profiles")) steps.push({ kind: "profiles", detail: `${countEntries(path.join(dir, "profiles"))} profile folder(s)`, target: context.profileRoot });
  if (has("snapshots")) steps.push({ kind: "snapshots", detail: `${countEntries(path.join(dir, "snapshots"))} snapshot entrie(s)`, target: context.snapshotRoot });
  if (has("mod-knowledge")) steps.push({ kind: "mod-knowledge", detail: "user knowledge overrides", target: path.join(context.dataDir || "", "mod-knowledge") });
  if (has("manifests")) steps.push({ kind: "manifests", detail: `${countEntries(path.join(dir, "manifests"))} manifest(s)`, target: path.join(context.dataDir || "", "manifests") });
  if (has("history")) steps.push({ kind: "history", detail: "audit + metrics", target: context.dataDir });
  if (has("settings.json")) steps.push({ kind: "settings", detail: "manager settings", target: path.join(context.userData || "", "config.json") });
  return { valid: true, manifest: check.manifest, steps, note: "Import writes manager metadata only. Duty files are not modified." };
}

function applyImport(dir, context = {}, options = {}) {
  const plan = planImport(dir, context);
  if (!plan.valid) throw new Error((plan.errors || ["Invalid backup."]).join(" "));
  const restored = [];
  const has = (rel) => fs.existsSync(path.join(dir, rel));

  if (has("profiles")) {
    copyDir(path.join(dir, "profiles"), context.profileRoot);
    restored.push("profiles");
  }
  if (has("snapshots")) {
    copyDir(path.join(dir, "snapshots"), context.snapshotRoot);
    restored.push("snapshots");
  }
  if (has("mod-knowledge")) {
    copyDir(path.join(dir, "mod-knowledge"), path.join(context.dataDir || "", "mod-knowledge"));
    restored.push("mod-knowledge");
  }
  if (has("manifests")) {
    copyDir(path.join(dir, "manifests"), path.join(context.dataDir || "", "manifests"));
    restored.push("manifests");
  }
  if (has("history")) {
    copyFile(path.join(dir, "history", "smart-audit.jsonl"), path.join(context.dataDir || "", "smart-audit.jsonl"));
    copyFile(path.join(dir, "history", "smart-metrics.json"), path.join(context.dataDir || "", "smart-metrics.json"));
    restored.push("history");
  }
  if (has("settings.json") && options.includeSettings !== false) {
    copyFile(path.join(dir, "settings.json"), path.join(context.userData || "", "config.json"));
    restored.push("settings");
  }
  return { restored, manifest: plan.manifest };
}

module.exports = { SCHEMA_VERSION, exportBackup, readBackup, planImport, applyImport };
