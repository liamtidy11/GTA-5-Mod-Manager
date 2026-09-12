const fs = require("fs");
const path = require("path");
const { exists, safeJoin, isEnhancedFolder } = require("./paths");
const modScanner = require("./modScanner");
const modClassifier = require("./modClassifier");
const conflictDetector = require("./conflictDetector");
const archiveSecurity = require("./archiveSecurity");
const manifestStore = require("./manifestStore");
const backupManager = require("./backupManager");
const { hashFileSync } = require("./hashUtil");

// Smart Install v1 orchestrator. Pipeline:
//   stage/extract -> scan -> archive security -> classify -> map destinations
//   -> conflict + protected-file check -> preview
//   -> (commit) backup -> transactional copy -> verify -> manifest
//   -> rollback on any failure; uninstall/enable via manifest + ownership.
//
// Everything is decoupled from the working launch path. It never touches
// launcher/battleye/permissions and only writes inside the Duty folder.

function slug(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "mod"
  );
}

function uniqueId(name) {
  return `${slug(name)}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function cleanName(name) {
  return String(name || "mod").replace(/\.(zip|rar|7z|oiv|exe)$/i, "");
}

// ---- Analyze -------------------------------------------------------------

// analyze({ source, dutyPath, dataDir, stagingRoot, officialPath?, legacyOwnersOf? })
// source may be a folder (scanned in place) or an archive (extracted to
// stagingRoot). Returns a preview object suitable for a UI and for commit().
async function analyze({ source, dutyPath, dataDir, stagingRoot, officialPath = "", legacyOwnersOf = null }) {
  if (!exists(source)) throw new Error("That file or folder no longer exists.");

  const baseName = path.basename(source);
  const id = uniqueId(baseName);
  let payloadDir = source;
  let stagingDir = null;

  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    if (!/\.(zip|rar|7z|oiv|exe)$/i.test(source)) {
      throw new Error("Drop a mod folder or archive (zip, rar, 7z, oiv).");
    }
    // Lazy-require the existing extractor so folder installs stay lightweight.
    const installer = require("./installer");
    stagingDir = path.join(stagingRoot, id);
    if (exists(stagingDir)) await fs.promises.rm(stagingDir, { recursive: true, force: true });
    await installer.extractArchive(source, stagingDir);
    payloadDir = stagingDir;
  }

  const scan = modScanner.scan(payloadDir);
  if (scan.isFullGame) {
    throw new Error("That looks like a full GTA V install. Drop the mod pack, not the game folder.");
  }
  if (scan.empty) {
    throw new Error("No installable files were found in that folder or archive.");
  }

  // Treat the archive as untrusted: reject traversal, surface executables.
  const security = archiveSecurity.validateEntries(
    scan.usableFiles.map((f) => f.rel),
    scan.root
  );
  if (!security.ok) {
    throw new Error(
      `Blocked: the archive contains unsafe paths that escape the folder (${security.traversal
        .slice(0, 3)
        .join(", ")}).`
    );
  }

  const classification = modClassifier.classify(scan);

  const copies = classification.perFile.map((item) => ({
    rel: item.rel,
    destination: item.destination,
    category: item.category,
    confidence: item.confidence,
    sourceAbs: path.join(scan.root, item.rel.split("/").join(path.sep)),
    size: item.size,
  }));

  const conflicts = conflictDetector.detect(copies, {
    dutyPath,
    dataDir,
    officialPath,
    legacyOwnersOf,
  });

  // Merge conflict actions back onto the file plan.
  const planByDest = new Map(conflicts.plan.map((p) => [`${p.rel}=>${p.destination}`, p]));
  const files = copies.map((c) => {
    const p = planByDest.get(`${c.rel}=>${c.destination}`) || { action: "add", severity: "NONE" };
    return {
      source: c.rel,
      destination: c.destination,
      category: c.category,
      confidence: c.confidence,
      size: c.size,
      action: p.action,
      severity: p.severity,
      reason: p.reason || "",
    };
  });

  const counts = {
    add: files.filter((f) => f.action === "add").length,
    replace: files.filter((f) => f.action === "replace").length,
    skip: files.filter((f) => f.action === "skip").length,
    noop: files.filter((f) => f.action === "noop").length,
  };

  return {
    id,
    name: cleanName(baseName),
    source,
    stagingDir,
    payloadRoot: scan.root,
    type: classification.type,
    confidence: classification.confidence,
    mode: classification.mode,
    modeLabel: classification.modeLabel,
    categories: classification.categories,
    unknownCount: classification.unknownCount,
    usableCount: classification.usableCount,
    counts,
    conflicts: { severity: conflicts.severity, items: conflicts.items },
    executables: security.executables,
    files,
  };
}

// ---- Commit (transactional) ---------------------------------------------

function copyVerified(sourceAbs, destAbs) {
  const tmp = `${destAbs}.smarttmp`;
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(sourceAbs, tmp);
  const srcHash = hashFileSync(sourceAbs);
  const tmpHash = hashFileSync(tmp);
  if (srcHash !== tmpHash) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw new Error(`Copy verification failed for ${path.basename(destAbs)}.`);
  }
  if (exists(destAbs)) fs.rmSync(destAbs, { force: true });
  fs.renameSync(tmp, destAbs);
  return srcHash;
}

// commit({ preview, dutyPath, dataDir, onProgress? }) -> manifest
async function commit({ preview, dutyPath, dataDir, onProgress = null }) {
  if (!isEnhancedFolder(dutyPath)) {
    throw new Error("The Duty (LSPDFR) folder is not set up yet. Create it before installing.");
  }
  if (preview.conflicts && preview.conflicts.severity === "BLOCKED") {
    const why = (preview.conflicts.items || [])
      .filter((i) => i.level === "BLOCKED")
      .map((i) => i.message)
      .join(" ");
    throw new Error(`This install is blocked: ${why}`);
  }

  const ops = (preview.files || []).filter((f) => f.action === "add" || f.action === "replace");
  const journal = [];

  try {
    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      const destAbs = safeJoin(dutyPath, op.destination.replace(/\//g, path.sep));
      const sourceAbs = path.join(preview.payloadRoot, op.source.split("/").join(path.sep));

      let backupRel = null;
      if (op.action === "replace" && exists(destAbs)) {
        backupRel = backupManager.backupFile(dataDir, preview.id, op.destination, destAbs);
      }

      const hash = copyVerified(sourceAbs, destAbs);
      journal.push({ destAbs, destination: op.destination, action: op.action, backupRel, hash });

      if (onProgress && (i % 10 === 0 || i === ops.length - 1)) {
        onProgress({ done: i + 1, total: ops.length, file: op.destination, phase: "install" });
      }
    }

    const manifest = {
      id: preview.id,
      name: preview.name,
      source: path.basename(preview.source || ""),
      type: preview.type,
      confidence: preview.confidence,
      installedAt: new Date().toISOString(),
      enabled: true,
      compatibility: "UNKNOWN",
      files: journal.map((j) => ({
        destination: j.destination,
        action: j.action,
        hash: j.hash,
        backup: j.backupRel,
      })),
      skipped: (preview.files || [])
        .filter((f) => f.action === "skip")
        .map((f) => ({ destination: f.destination, reason: f.reason })),
      executables: preview.executables || [],
    };
    manifestStore.write(dataDir, manifest);

    if (preview.stagingDir) await discardStaging(preview.stagingDir);
    return manifest;
  } catch (error) {
    // Roll back every file we touched, in reverse order.
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const entry = journal[i];
      try {
        if (entry.action === "add") {
          if (exists(entry.destAbs)) fs.rmSync(entry.destAbs, { force: true });
        } else if (entry.action === "replace") {
          if (entry.backupRel) {
            backupManager.restore(dataDir, preview.id, entry.destination, entry.destAbs);
          } else if (exists(entry.destAbs)) {
            fs.rmSync(entry.destAbs, { force: true });
          }
        }
      } catch {
        /* best-effort rollback */
      }
    }
    backupManager.removeModBackups(dataDir, preview.id);
    manifestStore.remove(dataDir, preview.id);
    throw new Error(`Install failed and was rolled back: ${error.message}`);
  }
}

// ---- Uninstall -----------------------------------------------------------

// uninstall({ modId, dutyPath, dataDir }) -> { id, removed, restored, kept }
async function uninstall({ modId, dutyPath, dataDir }) {
  const manifest = manifestStore.read(dataDir, modId);
  if (!manifest) throw new Error("That mod is not in the Smart Install registry.");

  let removed = 0;
  let restored = 0;
  let kept = 0;

  for (let i = (manifest.files || []).length - 1; i >= 0; i -= 1) {
    const file = manifest.files[i];
    const destAbs = safeJoin(dutyPath, file.destination.replace(/\//g, path.sep));

    // If another installed mod owns this destination, leave it in place.
    const otherOwners = manifestStore.ownersOf(dataDir, file.destination, modId);
    if (otherOwners.length) {
      kept += 1;
      continue;
    }

    if (file.backup && backupManager.hasBackup(dataDir, modId, file.destination)) {
      backupManager.restore(dataDir, modId, file.destination, destAbs);
      restored += 1;
    } else if (exists(destAbs)) {
      fs.rmSync(destAbs, { force: true });
      removed += 1;
    }
  }

  backupManager.removeModBackups(dataDir, modId);
  manifestStore.remove(dataDir, modId);
  return { id: modId, removed, restored, kept };
}

// ---- Enable / disable (park) --------------------------------------------

function disabledRoot(dataDir, modId) {
  return path.join(dataDir, "disabled", modId);
}

async function setEnabled({ modId, dutyPath, dataDir, enabled }) {
  const manifest = manifestStore.read(dataDir, modId);
  if (!manifest) throw new Error("That mod is not in the Smart Install registry.");
  if (Boolean(manifest.enabled) === Boolean(enabled)) return manifest;

  if (!enabled) {
    for (const file of manifest.files || []) {
      const destAbs = safeJoin(dutyPath, file.destination.replace(/\//g, path.sep));
      if (!exists(destAbs)) continue;
      // Keep the file if another enabled mod also owns it.
      const owners = manifestStore
        .ownersOf(dataDir, file.destination, modId)
        .filter((m) => m.enabled !== false);
      if (owners.length) continue;
      const parked = path.join(disabledRoot(dataDir, modId), file.destination.split("/").join(path.sep));
      fs.mkdirSync(path.dirname(parked), { recursive: true });
      fs.copyFileSync(destAbs, parked);
      fs.rmSync(destAbs, { force: true });
    }
  } else {
    for (const file of manifest.files || []) {
      const parked = path.join(disabledRoot(dataDir, modId), file.destination.split("/").join(path.sep));
      if (!exists(parked)) continue;
      const destAbs = safeJoin(dutyPath, file.destination.replace(/\//g, path.sep));
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(parked, destAbs);
    }
    try { fs.rmSync(disabledRoot(dataDir, modId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  manifest.enabled = Boolean(enabled);
  manifestStore.write(dataDir, manifest);
  return manifest;
}

async function discardStaging(stagingDir) {
  if (stagingDir && exists(stagingDir)) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

function list(dataDir) {
  return manifestStore.list(dataDir);
}

module.exports = {
  analyze,
  commit,
  uninstall,
  setEnabled,
  discardStaging,
  list,
  slug,
};
