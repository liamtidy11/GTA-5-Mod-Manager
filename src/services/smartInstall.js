const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { exists, safeJoin, isEnhancedFolder } = require("./paths");
const modScanner = require("./modScanner");
const modClassifier = require("./modClassifier");
const conflictDetector = require("./conflictDetector");
const dependencyChecker = require("./dependencyChecker");
const archiveSecurity = require("./archiveSecurity");
const manifestStore = require("./manifestStore");
const backupManager = require("./backupManager");
const { hashFileSync } = require("./hashUtil");
const environmentInventory = require("./environmentInventory");
const modRecognition = require("./modRecognition");
const versionDetector = require("./versionDetector");
const readmeAnalyzer = require("./readmeAnalyzer");
const dependencyResolver = require("./dependencyResolver");
const compatibilityService = require("./compatibilityService");
const recommendationEngine = require("./recommendationEngine");
const { fingerprintPath } = require("./packageFingerprint");
const { applyConfigPolicy } = require("./configPolicy");
const { snapshotEnvironment, revalidate } = require("./staleAnalysis");
const { appendAudit, bumpMetric, pushHistory } = require("./smartAudit");
const { SCHEMA_VERSION } = require("./manifestValidate");
const { diagnoseManagedMod, ownershipChanges } = require("./orphanDetector");
const { saveInstalledFile, removeStore } = require("./payloadStore");
const { repairManagedMod } = require("./smartRepair");
const { SmartInstallError, wrap } = require("./smartErrors");
const { analyzeVehiclePackage, applyArchiveRequiredGuard } = require("./vehicle/vehiclePackageAnalyzer");
const gtaArchiveService = require("./archive/gtaArchiveService");
const { isVehicleArchiveAsset } = require("./vehicle/vehicleAssetGrouper");
const { listDutyCandidateArchives } = require("./archive/archiveIndex");
const installAdvisor = require("./knowledge/installAdvisor");
const dependencyDownload = require("./knowledge/dependencyDownload");
const { normalizeDutyDest } = require("./knowledge/gameTreeNormalize");
const dutyLayoutFix = require("./knowledge/dutyLayoutFix");

// Smart Install V2 orchestrator. Analysis is read-only on Duty.
// Pipeline:
//   Archive security → Staging → Scan → Classification → Recognition
//   → Environment Inventory → README evidence → Dependency Resolution
//   → Compatibility → Install Safety → Recommendation → Preview → Commit
//
// Commit is the only stage that writes managed Duty files. It never touches
// launcher/battleye/permissions.

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

function analysisId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : uniqueId("analysis");
}

function describeUpdate(existing, files) {
  if (!existing) return null;
  const current = new Set((existing.files || []).map((f) => String(f.destination || f).replace(/\\/g, "/").toLowerCase()));
  const planned = (files || []).filter((f) => f.action === "add" || f.action === "replace");
  const incoming = new Set(planned.map((f) => String(f.destination).replace(/\\/g, "/").toLowerCase()));
  return {
    added: planned.filter((f) => f.action === "add").map((f) => f.destination),
    replaced: planned.filter((f) => f.action === "replace").map((f) => f.destination),
    removed: [...current].filter((dest) => !incoming.has(dest)),
    configsPreserved: (files || []).filter((f) => f.config && f.action === "skip").map((f) => f.destination),
  };
}

function cleanName(name) {
  return String(name || "mod").replace(/\.(zip|rar|7z|oiv|exe)$/i, "");
}

// ---- Analyze -------------------------------------------------------------

// analyze({ source, dutyPath, dataDir, stagingRoot, officialPath?, legacyOwnersOf? })
// source may be a folder (scanned in place) or an archive (extracted to
// stagingRoot). Returns a preview object suitable for a UI and for commit().
async function analyze({
  source,
  dutyPath,
  dataDir,
  stagingRoot,
  officialPath = "",
  legacyOwnersOf = null,
  configPolicy = "KEEP_EXISTING",
  vehiclePathMap = null,
  mockArchivePath = "",
  discoverOptions: discoverOptionsOverride = null,
  lookupGuides = false,
  aiApiKey = "",
  aiApiUrl = "",
}) {
  if (!exists(source)) {
    throw new SmartInstallError("PACKAGE_ERROR", "That file or folder no longer exists.", {
      whatToDo: "Drop the archive again.",
    });
  }

  const baseName = path.basename(source);
  const createdAt = new Date().toISOString();
  const analysisKey = analysisId();
  let id = uniqueId(baseName);
  let payloadDir = source;
  let stagingDir = null;

  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    if (!/\.(zip|rar|7z|oiv|exe)$/i.test(source)) {
      throw new SmartInstallError("PACKAGE_ERROR", "Drop a mod folder or archive (zip, rar, 7z, oiv).", {
        whatToDo: "Use a supported package type.",
      });
    }
    // Lazy-require the existing extractor so folder installs stay lightweight.
    const installer = require("./installer");
    stagingDir = path.join(stagingRoot, analysisKey);
    if (exists(stagingDir)) await fs.promises.rm(stagingDir, { recursive: true, force: true });
    await installer.extractArchive(source, stagingDir);
    payloadDir = stagingDir;
  }

  const scan = modScanner.scan(payloadDir);
  if (scan.isFullGame) {
    throw new SmartInstallError("PACKAGE_ERROR", "That looks like a full GTA V install. Drop the mod pack, not the game folder.");
  }
  if (scan.empty) {
    throw new SmartInstallError("PACKAGE_ERROR", "No installable files were found in that folder or archive.");
  }

  // Treat the archive as untrusted: reject traversal, surface executables.
  const security = archiveSecurity.validateEntries(
    scan.usableFiles.map((f) => f.rel),
    scan.root
  );
  if (!security.ok) {
    bumpMetric(dataDir, "blockedPackages");
    throw new SmartInstallError(
      "SECURITY_ERROR",
      `The archive contains unsafe paths that escape the folder (${security.traversal.slice(0, 3).join(", ")}).`,
      { whatToDo: "Use a normal mod archive. No files were changed." }
    );
  }

  const classification = modClassifier.classify(scan);
  const recognition = modRecognition.recognize(scan, {
    archiveName: baseName,
    classificationType: classification.type,
  });
  const matchedDll = ((recognition.knowledge && recognition.knowledge.recognition.dllNames) || []).find((dll) =>
    scan.usableFiles.some((f) => f.base.toLowerCase() === String(dll).toLowerCase())
  );
  let droppedVersion = "UNKNOWN";
  if (matchedDll) {
    const abs = path.join(
      scan.root,
      scan.usableFiles.find((f) => f.base.toLowerCase() === String(matchedDll).toLowerCase()).rel.split("/").join(path.sep)
    );
    droppedVersion = versionDetector.detectFileVersion(abs).version;
  }
  const duplicate = modRecognition.detectInstalled(recognition, { dutyPath, dataDir, droppedVersion });

  // Executables are never installed or run. We surface them and skip them.
  const executableItems = classification.perFile.filter((item) => archiveSecurity.isExecutable(item.rel));
  const installableItems = classification.perFile.filter((item) => !archiveSecurity.isExecutable(item.rel));

  const copies = installableItems.map((item) => ({
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
  let files = copies.map((c) => {
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

  // Append executables to the plan as explicit, non-installed skips.
  for (const item of executableItems) {
    files.push({
      source: item.rel,
      destination: item.destination,
      category: "EXECUTABLE",
      confidence: 0,
      size: item.size,
      action: "skip",
      severity: "WARNING",
      reason: "Executable — surfaced for review, never installed or run.",
    });
  }

  const existingManaged =
    duplicate.alreadyInstalled && duplicate.installed && duplicate.installed.source === "MANIFEST"
      ? manifestStore.read(dataDir, duplicate.installed.id)
      : null;
  if (existingManaged) id = existingManaged.id;
  const applied =
    existingManaged
      ? applyConfigPolicy(files, { dutyPath, payloadRoot: scan.root, policy: configPolicy })
      : { files, configPolicy, configDiffs: [] };
  files = applied.files;

  let discoverOptions = null;
  try {
    const candidates = listDutyCandidateArchives(dutyPath, officialPath);
    if (candidates.length) {
      const inventory = environmentInventory.getInventory({ dutyPath, dataDir });
      discoverOptions = {
        candidateArchives: candidates,
        dataDir,
        gtaBuild: (inventory.gta && inventory.gta.version) || "",
        officialPath,
      };
    }
  } catch {
    discoverOptions = null;
  }
  if (discoverOptionsOverride) discoverOptions = discoverOptionsOverride;

  const vehicle = analyzeVehiclePackage(scan, {
    dataDir,
    pathMap: vehiclePathMap,
    mockArchivePath,
    discoverOptions,
    capabilities: gtaArchiveService.getCapabilities(),
    dutyPath,
    officialPath,
    layer: null,
  });
  if (vehicle.archiveRequired) {
    files = applyArchiveRequiredGuard(files, vehicle);
  }

  // Overall severity + attention items include the surfaced executables.
  const items = [...conflicts.items];
  let severity = conflicts.severity;
  if (executableItems.length) {
    severity = conflictDetector.maxSeverity(severity, "WARNING");
    items.push({
      level: "WARNING",
      code: "executables",
      message: `${executableItems.length} executable file(s) will not be installed or run: ${executableItems
        .map((e) => e.rel)
        .join(", ")}.`,
      files: executableItems.map((e) => e.rel),
    });
  }

  // Drop-time dependency + compatibility checks (byte-scan of plugin DLLs).
  const deps = dependencyChecker.check({ files, payloadRoot: scan.root, dutyPath });
  const readme = readmeAnalyzer.analyze(scan);
  const resolved = dependencyResolver.resolve({
    recognition,
    dutyPath,
    dataDir,
    packFiles: copies,
    readme,
    packageDeps: deps,
  });
  const installedMods = manifestStore.list(dataDir).map((mod) => ({
    id: mod.id,
    modId: mod.recognitionModId || "",
    name: mod.name,
    enabled: mod.enabled !== false,
  }));
  const compatibility = compatibilityService.evaluate({
    recognition,
    dutyPath,
    dataDir,
    dependencies: resolved.dependencies,
    installedMods,
    packageCompatibility: deps.compatibility,
  });
  const installSafety = recommendationEngine.evaluateInstallSafety({
    conflicts: { severity, items },
    security,
    files,
    usableCount: classification.usableCount,
    rollbackAvailable: true,
    archiveRequired: vehicle.archiveRequired,
    archiveCapabilities: gtaArchiveService.getCapabilities(),
  });
  const recommendation = recommendationEngine.recommend({
    compatibility,
    installSafety,
    dependencies: resolved.dependencies,
    recognition,
    duplicate,
  });
  for (const dep of deps.dependencies) {
    if (dep.present) continue;
    severity = conflictDetector.maxSeverity(severity, dep.level === "required" ? "WARNING" : "WARNING");
    items.push({ level: "WARNING", code: "dependency", message: `Missing dependency: ${dep.note}`, files: [] });
  }
  for (const compat of deps.compatibility) {
    const level = compat.level === "incompatible" ? "HIGH_RISK" : "WARNING";
    severity = conflictDetector.maxSeverity(severity, level);
    items.push({ level, code: "compatibility", message: compat.note, files: [] });
  }
  if (duplicate.alreadyInstalled) {
    const installedVer = (duplicate.installed && duplicate.installed.version) || "UNKNOWN";
    items.push({
      level: "WARNING",
      code: "already-installed",
      message: duplicate.possibleUpdate
        ? `${recognition.name} appears to be already installed (${installedVer}). This package may be an update (${droppedVersion}).`
        : `${recognition.name} appears to be already installed.`,
      files: [],
    });
  }

  const counts = {
    add: files.filter((f) => f.action === "add").length,
    replace: files.filter((f) => f.action === "replace").length,
    skip: files.filter((f) => f.action === "skip").length,
    noop: files.filter((f) => f.action === "noop").length,
  };

  const environmentSnapshot = snapshotEnvironment({
    dutyPath,
    officialPath,
    source,
    payloadRoot: scan.root,
    files,
  });
  const canonicalModId = recognition.modId || null;
  appendAudit(dataDir, "ANALYZED", { installId: id, canonicalModId, analysisId: analysisKey });
  const installGuide = await installAdvisor.advise({
    scan,
    recognition,
    archiveName: baseName,
    lookup: Boolean(lookupGuides),
    apiKey: aiApiKey,
    apiUrl: aiApiUrl,
  });

  return {
    id,
    installId: id,
    analysisId: analysisKey,
    analysisVersion: 1,
    createdAt,
    name: cleanName(baseName),
    source,
    sourceArchive: baseName,
    sourceArchiveHash: environmentSnapshot.sourceArchiveHash,
    stagingDir,
    payloadRoot: scan.root,
    type: vehicle.detected ? vehicle.displayType : classification.type,
    confidence: classification.confidence,
    mode: classification.mode,
    modeLabel: classification.modeLabel,
    categories: classification.categories,
    unknownCount: classification.unknownCount,
    usableCount: classification.usableCount,
    counts,
    conflicts: { severity, items },
    executables: security.executables,
    dependencies: deps.dependencies,
    resolvedDependencies: resolved.dependencies,
    dependencySummary: resolved.summary,
    readmeEvidence: readme.dependencies,
    packageCompatibility: deps.compatibility,
    compatibility,
    installSafety,
    recommendation,
    recognition: {
      modId: recognition.modId,
      name: recognition.name,
      category: recognition.category,
      confidence: recognition.confidence,
      band: recognition.band,
      signals: recognition.signals,
      candidates: recognition.candidates || [],
      ambiguous: Boolean(recognition.ambiguous),
    },
    canonicalModId,
    droppedVersion,
    duplicate,
    configPolicy: applied.configPolicy,
    configDiffs: applied.configDiffs,
    updateReview: describeUpdate(existingManaged, files),
    environmentSnapshot,
    files,
    vehicle,
    archiveRequired: Boolean(vehicle.archiveRequired),
    archivePlan: vehicle.plan || null,
    installGuide,
    downloadOffers: dependencyDownload.offersFor(resolved.dependencies),
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

// commit({ preview, dutyPath, dataDir, onProgress?, officialPath?, hooks?, checkRunning?, configPolicy? }) -> manifest
async function commit({
  preview,
  dutyPath,
  dataDir,
  onProgress = null,
  officialPath = "",
  hooks = null,
  checkRunning = false,
} = {}) {
  const installId = preview.installId || preview.id;
  const canonicalModId = preview.canonicalModId || (preview.recognition && preview.recognition.modId) || null;
  appendAudit(dataDir, "INSTALL_STARTED", {
    installId,
    canonicalModId,
    analysisId: preview.analysisId || "",
  });

  if (!isEnhancedFolder(dutyPath)) {
    throw new SmartInstallError("DESTINATION_ERROR", "The Duty (LSPDFR) folder is not set up yet. Create it before installing.");
  }
  if (preview.archiveRequired) {
    throw new SmartInstallError(
      "ARCHIVE_ERROR",
      "Native GTA archive writing is not enabled in this build.",
      { whatToDo: "This package requires archive installation. No files were changed." }
    );
  }
  const archiveCopyAttempt = (preview.files || []).filter(
    (f) => (f.action === "add" || f.action === "replace") && isVehicleArchiveAsset(f.source || f.destination)
  );
  if (archiveCopyAttempt.length) {
    throw new SmartInstallError(
      "ARCHIVE_ERROR",
      "Archive-required vehicle assets cannot be copied into the Duty folder.",
      { whatToDo: "No files were changed." }
    );
  }

  if (preview.conflicts && preview.conflicts.severity === "BLOCKED") {
    bumpMetric(dataDir, "blockedPackages");
    const why = (preview.conflicts.items || [])
      .filter((i) => i.level === "BLOCKED")
      .map((i) => i.message)
      .join(" ");
    throw new SmartInstallError("SECURITY_ERROR", `This install is blocked: ${why}`, {
      whatToDo: "No files have been changed.",
    });
  }

  revalidate(preview, { dutyPath, officialPath, checkRunning });

  const ops = (preview.files || []).filter((f) => f.action === "add" || f.action === "replace");
  const journal = [];
  const previous = manifestStore.read(dataDir, installId);
  let rolled = false;

  try {
    for (let i = 0; i < ops.length; i += 1) {
      if (hooks && hooks.failAtCopy === i) {
        throw new SmartInstallError("TRANSACTION_ERROR", `Simulated copy failure at ${ops[i].destination}`, {
          file: ops[i].destination,
        });
      }
      const op = ops[i];
      const destination = normalizeDutyDest(op.destination) || op.destination;
      const destAbs = safeJoin(dutyPath, destination.replace(/\//g, path.sep));
      const sourceAbs = path.join(preview.payloadRoot, op.source.split("/").join(path.sep));

      let backupRel = null;
      if (op.action === "replace" && exists(destAbs)) {
        if (hooks && hooks.failBackup) {
          throw new SmartInstallError("TRANSACTION_ERROR", "Backup creation failed.", { file: destination });
        }
        backupRel = backupManager.backupFile(dataDir, installId, destination, destAbs);
      }

      const hash = copyVerified(sourceAbs, destAbs);
      saveInstalledFile(dataDir, installId, destination, destAbs);
      journal.push({ destAbs, destination, action: op.action, backupRel, hash });

      if (onProgress && (i % 10 === 0 || i === ops.length - 1)) {
        onProgress({ done: i + 1, total: ops.length, file: op.destination, phase: "install" });
      }
    }

    if (hooks && hooks.failValidate) {
      throw new SmartInstallError("TRANSACTION_ERROR", "Copy validation failed.");
    }
    if (hooks && hooks.failManifest) {
      throw new SmartInstallError("TRANSACTION_ERROR", "Manifest write failed.");
    }

    const relation = (preview.duplicate && preview.duplicate.relation) || "NEW";
    const historyEvent =
      relation === "UPDATE" ? "UPDATED" : relation === "DOWNGRADE" ? "DOWNGRADED" : previous ? "REINSTALLED" : "INSTALLED";
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      id: installId,
      installId,
      analysisId: preview.analysisId || "",
      canonicalModId,
      name: preview.name,
      source: path.basename(preview.source || ""),
      sourceArchiveHash: preview.sourceArchiveHash || "",
      type: preview.type,
      version: preview.droppedVersion || "UNKNOWN",
      confidence: preview.confidence,
      installedAt: (previous && previous.installedAt) || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      enabled: true,
      compatibility: (preview.compatibility && preview.compatibility.status) || "UNKNOWN",
      compatibilityStatus: (preview.compatibility && preview.compatibility.status) || "UNKNOWN",
      recognitionModId: canonicalModId || "",
      dependencySummary: preview.dependencySummary || null,
      recommendationStatus: (preview.recommendation && preview.recommendation.status) || "",
      configPolicy: preview.configPolicy || "KEEP_EXISTING",
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
      history: previous
        ? pushHistory(previous, historyEvent)
        : [{ event: "INSTALLED", at: new Date().toISOString() }],
      archiveOperations: Array.isArray(previous && previous.archiveOperations) ? previous.archiveOperations : [],
    };
    manifestStore.write(dataDir, manifest);

    if (preview.stagingDir) await discardStaging(preview.stagingDir);
    try {
      dutyLayoutFix.healDutyLayout({ dutyPath, dataDir });
    } catch {
      /* layout heal must not fail a successful install */
    }
    environmentInventory.invalidate({ dutyPath, dataDir });
    appendAudit(dataDir, "INSTALL_COMMITTED", { installId, canonicalModId, analysisId: preview.analysisId || "" });
    if (historyEvent === "UPDATED") appendAudit(dataDir, "UPDATED", { installId, canonicalModId, analysisId: preview.analysisId || "" });
    if (historyEvent === "DOWNGRADED") appendAudit(dataDir, "DOWNGRADED", { installId, canonicalModId, analysisId: preview.analysisId || "" });
    bumpMetric(dataDir, "successfulInstalls");
    return manifest;
  } catch (error) {
    appendAudit(dataDir, "INSTALL_FAILED", {
      installId,
      canonicalModId,
      analysisId: preview.analysisId || "",
      details: error.message,
    });
    appendAudit(dataDir, "ROLLBACK_STARTED", { installId, canonicalModId, analysisId: preview.analysisId || "" });
    let rollbackFailed = false;
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const entry = journal[i];
      try {
        if (hooks && hooks.failRollback) {
          throw new Error("Simulated rollback failure");
        }
        if (entry.action === "add") {
          if (exists(entry.destAbs)) fs.rmSync(entry.destAbs, { force: true });
        } else if (entry.action === "replace") {
          if (entry.backupRel) {
            backupManager.restore(dataDir, installId, entry.destination, entry.destAbs);
          } else if (exists(entry.destAbs)) {
            fs.rmSync(entry.destAbs, { force: true });
          }
        }
      } catch {
        rollbackFailed = true;
      }
    }
    if (!previous) {
      backupManager.removeModBackups(dataDir, installId);
      removeStore(dataDir, installId);
      manifestStore.remove(dataDir, installId);
    } else {
      manifestStore.write(dataDir, previous);
    }
    rolled = true;
    appendAudit(dataDir, "ROLLBACK_COMPLETED", { installId, canonicalModId, analysisId: preview.analysisId || "" });
    if (rollbackFailed) {
      bumpMetric(dataDir, "rollbackFailures");
      throw new SmartInstallError("ROLLBACK_ERROR", "Install failed and automatic restore was incomplete.", {
        whatToDo: "Close GTA V and RAGE Plugin Hook, then try again. Check the Duty folder before launching.",
      });
    }
    throw wrap("TRANSACTION_ERROR", new Error(`Install failed and was rolled back: ${error.message}`), {
      whatToDo: "Your existing installation was restored automatically.",
      file: error.file || "",
    });
  } finally {
    void rolled;
  }
}

// ---- Uninstall -----------------------------------------------------------

// uninstall({ modId, dutyPath, dataDir }) -> { id, removed, restored, kept }
async function uninstall({ modId, dutyPath, dataDir, force = false }) {
  const manifest = manifestStore.read(dataDir, modId);
  if (!manifest) throw new SmartInstallError("TRANSACTION_ERROR", "That mod is not in the Smart Install registry.");
  if (manifest.manifestStatus === "MANIFEST_ERROR") {
    throw new SmartInstallError("TRANSACTION_ERROR", "This mod's manifest is unreadable.", {
      whatToDo: "Files were left untouched. Inspect the manifest before removing anything.",
    });
  }

  const changed = ownershipChanges(manifest, dutyPath).filter((item) => {
    if (manifestStore.ownersOf(dataDir, item.destination, modId).length) return false;
    const record = (manifest.files || []).find((file) => file.destination === item.destination);
    return Boolean(record && record.backup);
  });
  if (changed.length && !force) {
    throw new SmartInstallError(
      "STATE_CHANGED",
      "FILE CHANGED OUTSIDE MOD MANAGER\n\nRemoving this mod may overwrite another change.",
      {
        file: changed[0].destination,
        whatToDo: "Review the changed files, then confirm removal if you still want to uninstall.",
        details: changed.map((item) => item.destination).join(", "),
      }
    );
  }

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
  removeStore(dataDir, modId);
  manifestStore.remove(dataDir, modId);
  environmentInventory.invalidate({ dutyPath, dataDir });
  appendAudit(dataDir, "REMOVED", { installId: modId, canonicalModId: manifest.canonicalModId || manifest.recognitionModId || null });
  return { id: modId, removed, restored, kept, changed };
}

// ---- Enable / disable (park) --------------------------------------------

function disabledRoot(dataDir, modId) {
  return path.join(dataDir, "disabled", modId);
}

async function setEnabled({ modId, dutyPath, dataDir, enabled }) {
  const manifest = manifestStore.read(dataDir, modId);
  if (!manifest) throw new SmartInstallError("TRANSACTION_ERROR", "That mod is not in the Smart Install registry.");
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
  manifest.history = pushHistory(manifest, enabled ? "ENABLED" : "DISABLED");
  manifestStore.write(dataDir, manifest);
  environmentInventory.invalidate({ dutyPath, dataDir });
  appendAudit(dataDir, enabled ? "ENABLED" : "DISABLED", {
    installId: modId,
    canonicalModId: manifest.canonicalModId || manifest.recognitionModId || null,
  });
  return manifest;
}

async function discardStaging(stagingDir) {
  if (stagingDir && exists(stagingDir)) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }
}

function cardHealth(mod) {
  if (mod.enabled === false) return "Warning";
  const summary = mod.dependencySummary;
  if (summary && summary.hasBlockingDependencyIssue) return "Broken";
  const status = mod.compatibilityStatus || mod.compatibility;
  if (status === "INCOMPATIBLE") return "Broken";
  if (status === "WARNING") return "Warning";
  return "Healthy";
}

function list(dataDir, dutyPath = "") {
  return manifestStore.list(dataDir).map((mod) => {
    const summary = mod.dependencySummary || {};
    const requiredTotal = Number(summary.requiredTotal) || 0;
    const requiredSatisfied = Number(summary.requiredSatisfied) || 0;
    const diagnosis = dutyPath ? diagnoseManagedMod(mod, { dutyPath, dataDir }) : null;
    let health = cardHealth(mod);
    if (mod.manifestStatus === "MANIFEST_ERROR") health = "Broken";
    else if (diagnosis && diagnosis.status === "BROKEN") health = "Broken";
    else if (diagnosis && diagnosis.status === "WARNING" && health === "Healthy") health = "Warning";
    return {
      ...mod,
      compatibilityStatus: mod.compatibilityStatus || mod.compatibility || "UNKNOWN",
      requiredTotal,
      requiredSatisfied,
      cardHealth: health,
      managedStatus: (diagnosis && diagnosis.status) || (mod.enabled === false ? "WARNING" : "HEALTHY"),
      historyLabels: (mod.history || []).slice(-5).map((entry) => {
        const when = entry.at ? new Date(entry.at).toLocaleDateString() : "";
        return `${entry.event} ${when}`.trim();
      }),
    };
  });
}

function repair({ modId, dutyPath, dataDir }) {
  const manifest = manifestStore.read(dataDir, modId);
  if (!manifest) throw new SmartInstallError("TRANSACTION_ERROR", "That mod is not in the Smart Install registry.");
  const result = repairManagedMod({ manifest, dutyPath, dataDir });
  const next = {
    ...manifest,
    history: pushHistory(manifest, "REPAIRED"),
  };
  manifestStore.write(dataDir, next);
  appendAudit(dataDir, "REPAIRED", { installId: modId, canonicalModId: manifest.canonicalModId || null });
  environmentInventory.invalidate({ dutyPath, dataDir });
  return result;
}

module.exports = {
  analyze,
  commit,
  uninstall,
  setEnabled,
  discardStaging,
  list,
  repair,
  ownershipChanges,
  slug,
};
