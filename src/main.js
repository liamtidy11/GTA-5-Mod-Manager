const { app, BrowserWindow, ipcMain, dialog, clipboard, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const config = require("./services/config");
const locator = require("./services/locator");
const sandbox = require("./services/sandbox");
const installer = require("./services/installer");
const smartInstall = require("./services/smartInstall");
const launcher = require("./services/launcher");
const registry = require("./services/registry");
const health = require("./services/health");
const battleye = require("./services/battleye");
const { defaultSandboxPath, exists } = require("./services/paths");
const gtaArchiveService = require("./services/archive/gtaArchiveService");
const overlays = require("./services/overlays");
const { createSessionManager } = require("./services/session/sessionManager");
const crashAnalyzer = require("./services/crash/crashAnalyzer");
const crashActions = require("./services/crash/crashActions");
const crashActionStore = require("./services/crash/crashActionStore");
const profileManager = require("./services/profiles/profileManager");
const profileStore = require("./services/profiles/profileStore");
const snapshotManager = require("./services/snapshots/snapshotManager");
const snapshotStore = require("./services/snapshots/snapshotStore");
const userKnowledge = require("./services/knowledge/userKnowledge");
const updateIntelligence = require("./services/update/updateIntelligence");
const modHealthV2 = require("./services/modHealthV2");
const dependencyGraph = require("./services/dependencyGraph");
const dutyHealthV2 = require("./services/dutyHealthV2");
const smartReadiness = require("./services/smartReadiness");
const troubleshoot = require("./services/troubleshoot");
const modKnowledge = require("./services/modKnowledge");
const modSearch = require("./services/modSearch");
const sessionFilter = require("./services/session/sessionFilter");
const storageManager = require("./services/storage/storageManager");
const managerBackup = require("./services/backup/managerBackup");
const profileRecommendation = require("./services/profiles/profileRecommendation");
const configIntelligence = require("./services/configIntelligence");
const keybindReader = require("./services/knowledge/keybindReader");
const dependencyDownload = require("./services/knowledge/dependencyDownload");
const dutyLayoutFix = require("./services/knowledge/dutyLayoutFix");
const runtimeCompatibility = require("./services/knowledge/runtimeCompatibility");
const diagnosticsReport = require("./services/diagnostics/report");
const selfCheck = require("./services/diagnostics/selfCheck");
const logViewer = require("./services/diagnostics/logViewer");
const { compareSessions } = require("./services/crash/sessionComparator");
const smartAudit = require("./services/smartAudit");
const { diagnoseManagedMod } = require("./services/orphanDetector");
const pkg = require("../package.json");

let win = null;
const pendingPlans = new Map();
const smartPlans = new Map();
let logWatch = null;
let sessions = null;

function userData() {
  return app.getPath("userData");
}

// Smart Install keeps its manifests/backups outside the clean Online install.
function smartDataDir() {
  return path.join(userData(), "data");
}

function smartStagingRoot() {
  return path.join(userData(), "staging-smart");
}

function sessionRoot() {
  return path.join(userData(), "sessions");
}

function actionRoot() {
  return path.join(userData(), "crash-actions");
}

function profileRoot() {
  return path.join(userData(), "profiles");
}

function snapshotRoot() {
  return path.join(userData(), "snapshots");
}

function v5Context(extras = {}) {
  const cfg = config.load(userData());
  return {
    profileRoot: profileRoot(),
    snapshotRoot: snapshotRoot(),
    dataDir: smartDataDir(),
    dutyPath: cfg.sandboxPath,
    officialPath: cfg.officialPath,
    ...extras,
  };
}

function ensureProfiles() {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath || !exists(cfg.sandboxPath)) return null;
  try {
    return profileManager.migrateIfNeeded(v5Context());
  } catch {
    return null;
  }
}

// V6 context adds manager-owned roots used by diagnostics, storage, and backup.
function v6Context(extras = {}) {
  return {
    ...v5Context(),
    userData: userData(),
    sessionRoot: sessionRoot(),
    actionRoot: actionRoot(),
    stagingRoot: smartStagingRoot(),
    appVersion: pkg.version,
    ...extras,
  };
}

function builtInKnowledge() {
  return modKnowledge.load({ userPath: userKnowledge.filePath(smartDataDir()) });
}

function managedList() {
  const cfg = config.load(userData());
  return smartInstall.list(smartDataDir(), cfg.sandboxPath);
}

function fullSessions(limit = 40) {
  try {
    const rows = getSessions().getRecentSessions(limit);
    return rows.map((row) => getSessions().getSession(row.sessionId)).filter(Boolean);
  } catch {
    return [];
  }
}

function adoptRuntimeEvidence() {
  try {
    const cfg = config.load(userData());
    runtimeCompatibility.adoptFromSessions({
      dataDir: smartDataDir(),
      dutyPath: cfg.sandboxPath,
      sessions: fullSessions(20),
      mods: managedList(),
      catalog: builtInKnowledge(),
    });
  } catch {
    /* local runtime evidence must not block health */
  }
}

function modHealthList() {
  const cfg = config.load(userData());
  adoptRuntimeEvidence();
  const sessions = fullSessions(40);
  const profiles = profileStore.listProfiles(profileRoot());
  const runtimeDb = runtimeCompatibility.loadEvidence(smartDataDir());
  return managedList().map((mod) =>
    modHealthV2.evaluateModHealth(mod, {
      diagnosis: cfg.sandboxPath && exists(cfg.sandboxPath) ? diagnoseManagedMod(mod, { dutyPath: cfg.sandboxPath, dataDir: smartDataDir() }) : null,
      sessions,
      profiles,
      runtime: runtimeCompatibility.lookup(runtimeDb, mod),
    })
  );
}

function missingRequiredDeps() {
  const graph = dependencyGraph.build({ mods: managedList(), database: builtInKnowledge() });
  const out = [];
  for (const node of graph.nodes) {
    for (const dep of graph.forward.get(node.installId) || []) {
      if (dep.kind === "REQUIRED" && !dep.installed) out.push({ name: dep.name, componentId: dep.componentId });
    }
  }
  return out;
}

function getSessions() {
  if (!sessions) {
    sessions = createSessionManager({
      root: sessionRoot(),
      onSessionFinalized: (session) => {
        try {
          const cfg = config.load(userData());
          runtimeCompatibility.recordFromSession({
            dataDir: smartDataDir(),
            dutyPath: (session && session.dutyPath) || cfg.sandboxPath,
            session,
            mods: managedList(),
            catalog: builtInKnowledge(),
          });
        } catch {
          /* local runtime evidence must not break session finalize */
        }
        if (!session || !session.crashActionId) return;
        const cfg = config.load(userData());
        crashActions.completeRetest(
          crashActions.createContext({
            actionRoot: actionRoot(),
            sessionRoot: sessionRoot(),
            dataDir: smartDataDir(),
            dutyPath: cfg.sandboxPath,
            session,
            persist: true,
          }),
          session
        );
      },
    });
  }
  return sessions;
}

function actionContext(session, extras = {}) {
  const cfg = config.load(userData());
  const analysis =
    extras.analysis ||
    (session && crashAnalyzer.getAnalysis(sessionRoot(), session.sessionId)) ||
    null;
  return crashActions.createContext({
    actionRoot: actionRoot(),
    sessionRoot: sessionRoot(),
    dataDir: smartDataDir(),
    dutyPath: cfg.sandboxPath,
    stagingRoot: smartStagingRoot(),
    session,
    analysis,
    persist: extras.persist,
    ...extras,
  });
}

function lastSessionSummary() {
  try {
    const latest = getSessions().getLatestSession();
    if (!latest) return null;
    const stored = crashAnalyzer.getAnalysis(sessionRoot(), latest.sessionId);
    const failed = crashAnalyzer.canAnalyze(latest);
    return {
      sessionId: latest.sessionId,
      startedAt: latest.startedAt,
      endedAt: latest.endedAt,
      durationMs: latest.durationMs,
      result: latest.result,
      confidence: latest.confidence,
      state: latest.state,
      enabledModCount: (latest.mods || []).filter((mod) => mod.enabled).length,
      analysis: failed ? crashAnalyzer.compactAnalysis(stored) : null,
      pendingRetest: crashActions.recoveryState(actionRoot()),
    };
  } catch {
    return null;
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function log(level, message) {
  send("log", { level, message, at: new Date().toISOString() });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1080,
    minHeight: 700,
    backgroundColor: "#0B0D10",
    title: "GTA V Mod Manager",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) log("warn", message);
  });
  win.webContents.on("did-fail-load", (_event, code, desc) => {
    log("error", `UI failed to load: ${desc} (${code})`);
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function snapshot() {
  const cfg = config.load(userData());
  if (cfg.sandboxPath && exists(cfg.sandboxPath)) {
    try {
      const healed = dutyLayoutFix.healDutyLayout({ dutyPath: cfg.sandboxPath, dataDir: smartDataDir() });
      if (healed && healed.changed) {
        const n = (healed.moved || []).length + (healed.repaired || []).length + (healed.restored || []).length;
        log("ok", `Smart Install moved ${n} pack file(s) into the Duty folders plugins expect.`);
      }
    } catch {
      /* layout heal must not block the UI */
    }
  }
  const game = sandbox.status(cfg.officialPath, cfg.sandboxPath);
  const rawMods = cfg.sandboxPath && exists(cfg.sandboxPath) ? registry.load(cfg.sandboxPath).mods : [];
  const tests =
    cfg.sandboxPath && exists(cfg.sandboxPath)
      ? health.runChecks(cfg.sandboxPath, cfg.officialPath, { dataDir: smartDataDir() })
      : null;
  const mods = cfg.sandboxPath ? health.withModStatus(cfg.sandboxPath, rawMods) : rawMods;
  return {
    config: cfg,
    game,
    mods,
    tests,
    archiveBackend: gtaArchiveService.getBackendHealth(),
    lastSession: lastSessionSummary(),
    pendingRetest: crashActions.recoveryState(actionRoot()),
    profile: (() => {
      try {
        return profileManager.activeSummary(v5Context());
      } catch {
        return null;
      }
    })(),
    storage: snapshotManager.storageUsage(profileRoot(), snapshotRoot()),
    dutyHealth: (() => {
      try {
        const profileSummary = profileManager.activeSummary(v5Context());
        return dutyHealthV2.summarize({ tests, profile: profileSummary, overlays: overlays.overlayStatus() });
      } catch {
        return null;
      }
    })(),
  };
}

app.whenReady().then(() => {
  createWindow();
  try {
    getSessions().reconcileIncomplete();
  } catch {
    /* session recovery must not block startup */
  }
  try {
    ensureProfiles();
  } catch {
    /* migration must not change Duty or block startup */
  }
});

app.on("window-all-closed", () => {
  stopLogWatch();
  try {
    getSessions().stopMonitor();
  } catch {
    /* keep an incomplete session if GTA is still running */
  }
  app.quit();
});

ipcMain.handle("state:get", async () => snapshot());

ipcMain.handle("game:detect", async () => {
  const found = await locator.detect();
  if (!found) return { found: false };
  return {
    found: true,
    path: found.path,
    launcher: found.launcher,
    sandboxPath: defaultSandboxPath(found.path),
  };
});

ipcMain.handle("game:inspect", async (_event, folder) => locator.inspect(folder));

ipcMain.handle("dialog:folder", async (_event, title) => {
  const result = await dialog.showOpenDialog(win, {
    title: title || "Select folder",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:archives", async () => {
  const result = await dialog.showOpenDialog(win, {
    title: "Select mod archives",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "LSPDFR and mods", extensions: ["zip", "rar", "7z", "oiv", "exe"] }],
  });
  if (result.canceled) return [];
  return result.filePaths;
});

ipcMain.handle("setup:save", async (_event, payload) => {
  const inspected = locator.inspect(payload.officialPath);
  if (!inspected.ok) throw new Error(inspected.reason);
  const sandboxPath = payload.sandboxPath || defaultSandboxPath(payload.officialPath);
  return config.save(userData(), {
    officialPath: payload.officialPath,
    sandboxPath,
    launcher: payload.launcher || inspected.launcher,
    cloneMode: payload.cloneMode || "linked",
    setupComplete: false,
  });
});

ipcMain.handle("sandbox:create", async () => {
  const cfg = config.load(userData());
  if (!cfg.officialPath || !cfg.sandboxPath) {
    throw new Error("Set the official Enhanced folder and LSPDFR folder first.");
  }
  log("info", `Creating LSPDFR folder (${cfg.cloneMode})…`);
  const result = await sandbox.create({
    officialPath: cfg.officialPath,
    sandboxPath: cfg.sandboxPath,
    mode: cfg.cloneMode,
    onProgress: (progress) => send("progress", progress),
  });
  config.save(userData(), { setupComplete: true });
  log("ok", `LSPDFR folder ready — ${result.linkedCount} linked, ${result.copiedCount} copied.`);
  return { ...result, state: snapshot() };
});

function clipboardPaths() {
  const found = [];
  const formats = clipboard.availableFormats();
  const readNamed = (format, encoding) => {
    try {
      if (!formats.includes(format)) return;
      const text = clipboard.readBuffer(format).toString(encoding).replace(/\u0000+$/g, "");
      for (const part of text.split("\u0000")) {
        const value = part.trim().replace(/^file:\/\/\//i, "").replace(/\//g, "\\");
        if (value && exists(value)) found.push(value);
      }
    } catch {
      /* format not available */
    }
  };
  readNamed("FileNameW", "ucs2");
  readNamed("FileName", "utf8");
  const text = clipboard.readText().trim().replace(/^"+|"+$/g, "");
  if (text && exists(text)) found.push(text);
  return [...new Set(found)];
}

ipcMain.handle("clipboard:paths", async () => clipboardPaths());

ipcMain.handle("mods:analyze", async (_event, archivePath) => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Finish setup before installing mods.");
  const staging = path.join(userData(), "staging");
  const label = path.basename(archivePath);
  const isDir = exists(archivePath) && fs.statSync(archivePath).isDirectory();
  log("info", isDir ? `Reading folder ${label}…` : `Unpacking ${label}…`);
  const plan = await installer.analyze(archivePath, staging);
  pendingPlans.set(plan.id, plan);
  const kinds = (plan.kindLabels || []).join(", ") || "mixed";
  log("ok", `Unpacked ${plan.fileCount} files from ${plan.archiveName} (${kinds}).`);
  return {
    id: plan.id,
    archiveName: plan.archiveName,
    fileCount: plan.fileCount,
    folders: plan.folders,
    warnings: plan.warnings,
    kinds: plan.kinds || [],
    kindLabels: plan.kindLabels || [],
    notes: plan.notes || [],
    dlcPacks: plan.dlcPacks || [],
  };
});

ipcMain.handle("mods:installAuto", async (_event, sourcePath) => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Finish setup before installing mods.");
  const staging = path.join(userData(), "staging");
  const label = path.basename(sourcePath);
  const isDir = exists(sourcePath) && fs.statSync(sourcePath).isDirectory();
  log("info", isDir ? `Reading folder ${label}…` : `Unpacking ${label}…`);
  const plan = await installer.analyze(sourcePath, staging);
  pendingPlans.set(plan.id, plan);
  const kinds = (plan.kindLabels || []).join(", ") || "mixed";
  log("ok", `Found ${plan.fileCount} files (${kinds}). Installing automatically…`);
  try {
    const record = await installer.commit({
      plan,
      sandboxPath: cfg.sandboxPath,
      officialPath: cfg.officialPath,
      onProgress: (progress) => send("progress", progress),
    });
    pendingPlans.delete(plan.id);
    if (record.dlcRegistered?.length) {
      log("ok", `Registered DLC packs: ${record.dlcRegistered.join(", ")}.`);
    }
    health.ensureNoBattlEye(cfg.sandboxPath);
    log("ok", `Installed ${record.name}. BattlEye is off for Story Mode.`);
    const state = snapshot();
    if (state.tests) {
      log(state.tests.verdict === "blocked" ? "error" : state.tests.verdict === "caution" ? "warn" : "ok", state.tests.summary);
    }
    return { record, state, tests: state.tests };
  } catch (error) {
    pendingPlans.delete(plan.id);
    await installer.discardStaging(plan.extractDir);
    throw error;
  }
});

ipcMain.handle("mods:commit", async (_event, planId) => {
  const plan = pendingPlans.get(planId);
  if (!plan) throw new Error("That install preview expired. Drop the archive again.");
  const cfg = config.load(userData());
  log("info", `Installing ${plan.archiveName} into the LSPDFR folder…`);
  const record = await installer.commit({
    plan,
    sandboxPath: cfg.sandboxPath,
    officialPath: cfg.officialPath,
    onProgress: (progress) => send("progress", progress),
  });
  pendingPlans.delete(planId);
  if (record.dlcRegistered?.length) {
    log("ok", `Registered DLC packs: ${record.dlcRegistered.join(", ")}.`);
  }
  log("ok", `Installed ${record.name} (${record.fileCount} files).`);
  const state = snapshot();
  if (state.tests) {
    log(state.tests.verdict === "blocked" ? "error" : state.tests.verdict === "caution" ? "warn" : "ok", state.tests.summary);
  }
  return { record, state };
});

ipcMain.handle("mods:cancel", async (_event, planId) => {
  const plan = pendingPlans.get(planId);
  if (plan) {
    await installer.discardStaging(plan.extractDir);
    pendingPlans.delete(planId);
  }
  return true;
});

ipcMain.handle("mods:uninstall", async (_event, modId) => {
  const cfg = config.load(userData());
  await installer.uninstall(cfg.sandboxPath, cfg.officialPath, modId);
  log("ok", "Mod removed. Official files were restored where possible.");
  return snapshot();
});

ipcMain.handle("mods:setEnabled", async (_event, { id, enabled }) => {
  const cfg = config.load(userData());
  await installer.setEnabled(cfg.sandboxPath, cfg.officialPath, id, enabled);
  log("ok", enabled ? "Mod enabled." : "Mod disabled.");
  return snapshot();
});

// ---- Smart Install v1 (additive; does not touch the working launch/install) ----

function smartUserError(error) {
  if (error && error.category === "STATE_CHANGED") {
    const next = new Error(
      "ENVIRONMENT CHANGED\n\nThe Duty installation changed after this preview was created.\n\nPlease review the updated installation preview."
    );
    next.category = "STATE_CHANGED";
    return next;
  }
  if (error && typeof error.formatUser === "function") {
    const next = new Error(error.formatUser());
    next.category = error.category;
    return next;
  }
  return error;
}

ipcMain.handle("smart:analyze", async (_event, sourcePath) => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Finish setup before installing mods.");
  const label = path.basename(sourcePath);
  log("info", `Smart Install: analyzing ${label}…`);
  try {
    const preview = await smartInstall.analyze({
      source: sourcePath,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      stagingRoot: smartStagingRoot(),
      officialPath: cfg.officialPath,
      legacyOwnersOf: (destRel) => registry.ownersOf(cfg.sandboxPath, destRel),
      lookupGuides: cfg.lookupInstallGuides !== false,
      aiApiKey: cfg.aiGuideEnabled ? cfg.aiApiKey : "",
      aiApiUrl: cfg.aiApiUrl || "",
    });
    if (preview.duplicate && (preview.duplicate.relation === "UPDATE" || preview.duplicate.relation === "DOWNGRADE")) {
      const installedId = (preview.duplicate.installed && preview.duplicate.installed.id) || preview.installId;
      const installed = managedList().find((mod) => mod.id === installedId);
      const userEntry = userKnowledge.getEntry(smartDataDir(), {
        installId: installed && installed.id,
        canonicalModId: (installed && installed.canonicalModId) || preview.canonicalModId,
      });
      preview.updateDetected = updateIntelligence.detectUpdate({
        installed: installed || preview.duplicate.installed,
        preview,
        userEntry,
        sessions: fullSessions(20),
      });
    } else {
      preview.installRisk = updateIntelligence.scoreUpdateRisk({
        parkedFrameworkRequired: (preview.resolvedDependencies || []).some((d) => d.kind === "REQUIRED" && d.state === "DISABLED"),
        compatibilityUnknown: !preview.compatibility || preview.compatibility.status === "UNKNOWN",
        compatibilityWarning: preview.compatibility && (preview.compatibility.status === "WARNING" || preview.compatibility.status === "INCOMPATIBLE"),
        noProtectedFiles: !((preview.installSafety && preview.installSafety.findings) || []).some((f) => f.code === "PROTECTED_FILE"),
        configsPreserved: preview.configPolicy === "KEEP_EXISTING",
        dependenciesSame: true,
        compatibilitySameOrVerified: preview.compatibility && (preview.compatibility.status === "VERIFIED" || preview.compatibility.status === "LIKELY_COMPATIBLE"),
      });
    }
    smartPlans.set(preview.id, preview);
    log(
      "ok",
      `Smart Install: ${preview.name} looks like ${preview.type} ` +
        `(${Math.round(preview.confidence * 100)}% confidence). ` +
        `${preview.counts.add} new, ${preview.counts.replace} replace, ${preview.counts.skip} skipped.`
    );
    if (preview.executables.length) {
      log("warn", `Smart Install: this pack contains executables that will NOT be run: ${preview.executables.join(", ")}.`);
    }
    return preview;
  } catch (error) {
    throw smartUserError(error);
  }
});

ipcMain.handle("smart:commit", async (_event, planId) => {
  const preview = smartPlans.get(planId);
  if (!preview) throw new Error("That install preview expired. Drop the archive again.");
  const cfg = config.load(userData());
  log("info", `Smart Install: installing ${preview.name}…`);
  try {
    const relation = preview.duplicate && preview.duplicate.relation;
    const riskLevel =
      (preview.updateDetected && preview.updateDetected.risk && preview.updateDetected.risk.level) ||
      (preview.installRisk && preview.installRisk.level) ||
      "UNKNOWN";
    const wantUpdateSnap = (relation === "UPDATE" && cfg.snapshotBeforeUpdate !== false) || relation === "DOWNGRADE";
    const wantRiskSnap = smartReadiness.shouldSnapshotBeforeInstall({ risk: riskLevel, settings: cfg });
    if (wantUpdateSnap || wantRiskSnap) {
      try {
        snapshotManager.create(v5Context(), {
          reason: relation === "DOWNGRADE" ? snapshotManager.REASONS.BEFORE_DOWNGRADE : snapshotManager.REASONS.BEFORE_UPDATE,
          profileId: profileStore.loadIndex(profileRoot()).activeProfileId,
        });
      } catch {
        /* snapshot must not block install */
      }
    }
    const manifest = await smartInstall.commit({
      preview,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      officialPath: cfg.officialPath,
      checkRunning: true,
      onProgress: (progress) => send("progress", progress),
    });
    smartPlans.delete(planId);
    try {
      profileManager.markDrifted(v5Context(), [`${manifest.name} was installed or updated`]);
    } catch {
      /* drift flag must not block install */
    }
    health.ensureNoBattlEye(cfg.sandboxPath);
    log("ok", `Smart Install: installed ${manifest.name} (${manifest.files.length} files). BattlEye kept off for Story Mode.`);
    const state = snapshot();
    if (state.tests) {
      log(state.tests.verdict === "blocked" ? "error" : state.tests.verdict === "caution" ? "warn" : "ok", state.tests.summary);
    }
    return { manifest, state };
  } catch (error) {
    smartPlans.delete(planId);
    if (preview.stagingDir) await smartInstall.discardStaging(preview.stagingDir);
    throw smartUserError(error);
  }
});

ipcMain.handle("smart:cancel", async (_event, planId) => {
  const preview = smartPlans.get(planId);
  if (preview) {
    if (preview.stagingDir) await smartInstall.discardStaging(preview.stagingDir);
    smartPlans.delete(planId);
  }
  return true;
});

ipcMain.handle("smart:list", async () => {
  const cfg = config.load(userData());
  return smartInstall.list(smartDataDir(), cfg.sandboxPath || "");
});

ipcMain.handle("smart:uninstall", async (_event, payload) => {
  const cfg = config.load(userData());
  const modId = typeof payload === "string" ? payload : payload && payload.id;
  const force = Boolean(payload && payload.force);
  try {
    const result = await smartInstall.uninstall({
      modId,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      force,
    });
    log("ok", `Smart Install: removed mod (${result.restored} restored, ${result.removed} removed, ${result.kept} kept for other mods).`);
    return { result, state: snapshot() };
  } catch (error) {
    if (error && error.category === "STATE_CHANGED") {
      return { needsConfirm: true, message: error.userMessage, state: snapshot() };
    }
    throw smartUserError(error);
  }
});

ipcMain.handle("smart:repair", async (_event, modId) => {
  const cfg = config.load(userData());
  try {
    snapshotManager.create(v5Context(), { reason: snapshotManager.REASONS.BEFORE_REPAIR });
  } catch {
    /* snapshot must not block repair */
  }
  const result = smartInstall.repair({
    modId,
    dutyPath: cfg.sandboxPath,
    dataDir: smartDataDir(),
  });
  try {
    profileManager.markDrifted(v5Context(), ["A managed repair was applied"]);
  } catch {
    /* drift flag must not block repair */
  }
  log("ok", `Smart Install: repair finished (${(result.restored || []).length} restored).`);
  return { result, state: snapshot() };
});

ipcMain.handle("smart:setEnabled", async (_event, { id, enabled }) => {
  const cfg = config.load(userData());
  const manifest = await smartInstall.setEnabled({
    modId: id,
    dutyPath: cfg.sandboxPath,
    dataDir: smartDataDir(),
    enabled,
  });
  try {
    profileManager.markDrifted(v5Context(), [`${manifest.name || id} was ${enabled ? "enabled" : "disabled"}`]);
  } catch {
    /* drift flag must not block enable/disable */
  }
  log("ok", enabled ? "Smart Install: mod enabled." : "Smart Install: mod disabled.");
  return { manifest, state: snapshot() };
});

function stopLogWatch() {
  if (logWatch) {
    clearInterval(logWatch.timer);
    logWatch = null;
  }
}

function startLogWatch(sandboxPath) {
  stopLogWatch();
  const logFile = path.join(sandboxPath, "RagePluginHook.log");
  const started = Date.now();
  let linesSeen = -1;
  log("info", "Watching RagePluginHook.log for new load errors (60s).");
  logWatch = {
    timer: setInterval(() => {
      if (Date.now() - started > 60_000) {
        log("ok", "Launch watch finished. If the game is still loading, check Crash reports after it starts.");
        stopLogWatch();
        return;
      }
      try {
        if (!exists(logFile)) return;
        const text = fs.readFileSync(logFile, "utf8");
        const lineCount = String(text).split(/\r?\n/).length;
        if (linesSeen < 0) {
          linesSeen = lineCount;
          return;
        }
        if (lineCount < linesSeen) {
          linesSeen = 0;
        }
        const parsed = health.parseNewFindings(linesSeen, text);
        linesSeen = parsed.lineCount;
        for (const finding of parsed.findings) {
          log(finding.level === "ok" ? "ok" : "error", finding.message);
        }
      } catch {
        /* log may be locked while RPH writes */
      }
    }, 1500),
  };
}

ipcMain.handle("launch:lspdfr", async () => {
  const cfg = config.load(userData());
  const tracker = getSessions();
  const overlaysBefore = overlays.overlayStatus();
  const pending = crashActions.pendingForLaunch(actionRoot());
  const profileIndex = profileStore.loadIndex(profileRoot());
  tracker.beginLaunch({
    dutyPath: cfg.sandboxPath,
    officialPath: cfg.officialPath,
    dataDir: smartDataDir(),
    appVersion: pkg.version,
    overlayStatus: overlaysBefore,
    retestOfSessionId: pending ? pending.sessionId : "",
    crashActionId: pending ? pending.actionId : "",
    profileId: profileIndex.activeProfileId || "",
    snapshotId: snapshotManager.latestId(snapshotRoot()) || "",
  });
  try {
    const result = await launcher.launchLspdfr({
      sandboxPath: cfg.sandboxPath,
      officialPath: cfg.officialPath,
    });
    const overlaysAfter = overlays.overlayStatus();
    tracker.markLaunching(result, {
      nvidiaClosedByManager: Boolean(overlaysBefore.nvidiaOverlay || overlaysBefore.nvidiaShare) && !overlaysAfter.nvidiaOverlay,
    });
    if (pending) {
      crashActions.markRetestLaunched(actionContext(tracker.getSession(), { persist: true }), pending.actionId, tracker.currentId());
    }
    tracker.startMonitor();
    log("ok", "Launching Rage Plugin Hook. If Windows asks for permission, click Yes.");
    log("info", "Steam may ask to launch with custom arguments (-skipPatchChecker -launchTitleInFolder). Click Play. That keeps Story Mode in the LSPDFR folder.");
    log("info", "Do not click Cancel, and do not start the game from the Steam library.");
    startLogWatch(cfg.sandboxPath);
    return result;
  } catch (error) {
    tracker.failLaunch(error);
    throw error;
  }
});

ipcMain.handle("session:list", async () => getSessions().getRecentSessions(40));
ipcMain.handle("session:get", async (_event, sessionId) => {
  const session = getSessions().getSession(sessionId);
  const attached = crashAnalyzer.attachAnalysis(sessionRoot(), session);
  if (!attached) return null;
  return {
    ...attached,
    crashActions: crashActionStore.actionsForSession(actionRoot(), sessionId),
  };
});
ipcMain.handle("session:analyze", async (_event, sessionId) => {
  return crashAnalyzer.analyzeSession(sessionId, { root: sessionRoot(), actionRoot: actionRoot() });
});
ipcMain.handle("crashAction:plan", async (_event, sessionId) => {
  const session = getSessions().getSession(sessionId);
  if (!session) throw new Error("Session not found.");
  const analysis = crashAnalyzer.getAnalysis(sessionRoot(), sessionId);
  if (!analysis) throw new Error("Analyze the crash before planning a test.");
  return crashActions.planForSession(actionContext(session, { analysis, persist: true }));
});
ipcMain.handle("crashAction:apply", async (_event, actionId) => {
  const action = crashActionStore.getAction(actionRoot(), actionId);
  if (!action) throw new Error("That crash action was not found.");
  const session = getSessions().getSession(action.sessionId);
  try {
    snapshotManager.create(v5Context(), { reason: snapshotManager.REASONS.BEFORE_CRASH_ACTION });
  } catch {
    /* snapshot must not block a crash test */
  }
  const applied = await crashActions.applyAction(actionContext(session, { persist: true }), actionId);
  try {
    profileManager.markDrifted(v5Context(), [`Crash test: ${(applied.changes && applied.changes[0]) || applied.type}`]);
  } catch {
    /* drift flag must not block a crash test */
  }
  return applied;
});
ipcMain.handle("crashAction:restore", async (_event, actionId) => {
  const action = crashActionStore.getAction(actionRoot(), actionId);
  if (!action) throw new Error("That crash action was not found.");
  const session = getSessions().getSession(action.sessionId);
  return crashActions.restoreAction(actionContext(session, { persist: true }), actionId);
});
ipcMain.handle("crashAction:keep", async (_event, actionId) => {
  const action = crashActionStore.getAction(actionRoot(), actionId);
  if (!action) throw new Error("That crash action was not found.");
  const session = getSessions().getSession(action.sessionId);
  return crashActions.keepAction(actionContext(session, { persist: true }), actionId);
});
ipcMain.handle("crashAction:pending", async () => crashActions.recoveryState(actionRoot()));

ipcMain.handle("profile:list", async () => {
  ensureProfiles();
  const ctx = v5Context();
  const current = require("./services/profiles/managedState").captureManagedState(ctx);
  return profileStore.listProfiles(profileRoot()).map((profile) => ({
    ...profile,
    health: profileManager.healthOf(profile, current, (installId, version) =>
      (current.mods || []).some((mod) => mod.installId === installId && mod.version === version)
    ),
  }));
});
ipcMain.handle("profile:active", async () => {
  ensureProfiles();
  return profileManager.activeSummary(v5Context());
});
ipcMain.handle("profile:create", async (_event, extras) => {
  ensureProfiles();
  return { profile: profileManager.createFromCurrent(v5Context(), extras || {}), state: snapshot() };
});
ipcMain.handle("profile:rename", async (_event, { profileId, name }) => profileManager.rename(v5Context(), profileId, name));
ipcMain.handle("profile:duplicate", async (_event, { profileId, name }) => profileManager.duplicate(v5Context(), profileId, name));
ipcMain.handle("profile:delete", async (_event, profileId) => {
  profileManager.remove(v5Context(), profileId);
  return snapshot();
});
ipcMain.handle("profile:planSwitch", async (_event, profileId) => profileManager.planSwitch(v5Context(), profileId));
ipcMain.handle("profile:switch", async (_event, { profileId, confirmOverwriteConfigs }) => {
  const result = await profileManager.switchProfile(v5Context(), profileId, {
    confirmOverwriteConfigs,
    beforeSwitch: async () => {
      snapshotManager.create(v5Context(), { reason: snapshotManager.REASONS.BEFORE_PROFILE_SWITCH });
    },
  });
  return { ...result, state: snapshot() };
});
ipcMain.handle("profile:knownGood", async (_event, profileId) => profileManager.markKnownGood(v5Context(), profileId));
ipcMain.handle("profile:updateFromCurrent", async (_event, profileId) => {
  profileManager.updateProfileFromCurrent(v5Context(), profileId);
  return snapshot();
});
ipcMain.handle("profile:restoreKnownGood", async () => {
  const index = profileStore.loadIndex(profileRoot());
  if (!index.knownGoodProfileId) throw new Error("No known-good profile is marked yet.");
  const plan = profileManager.planSwitch(v5Context(), index.knownGoodProfileId);
  return { plan, profileId: index.knownGoodProfileId, text: profileManager.describePlan(plan) };
});
ipcMain.handle("snapshot:list", async () => snapshotStore.listSnapshots(snapshotRoot()));
ipcMain.handle("snapshot:create", async (_event, extras) => {
  const snap = snapshotManager.create(v5Context(), { ...extras, reason: extras && extras.reason ? extras.reason : snapshotManager.REASONS.MANUAL });
  return { snapshot: snap, state: snapshot() };
});
ipcMain.handle("snapshot:pin", async (_event, { snapshotId, pinned }) => snapshotManager.pin(v5Context(), snapshotId, pinned));
ipcMain.handle("snapshot:delete", async (_event, snapshotId) => {
  snapshotManager.remove(v5Context(), snapshotId);
  return snapshot();
});
ipcMain.handle("snapshot:plan", async (_event, snapshotId) => snapshotManager.planRestore(v5Context(), snapshotId));
ipcMain.handle("snapshot:restore", async (_event, snapshotId) => {
  const result = await snapshotManager.restore(v5Context(), snapshotId);
  return { ...result, state: snapshot() };
});

ipcMain.handle("launch:online", async () => {
  const cfg = config.load(userData());
  const result = await launcher.launchOnline({
    officialPath: cfg.officialPath,
    sandboxPath: cfg.sandboxPath,
    launcher: cfg.launcher,
  });
  log("ok", "Launching clean Enhanced for GTA Online. BattlEye is back on for Online.");
  return result;
});

ipcMain.handle("folder:open", async (_event, which) => {
  const cfg = config.load(userData());
  const target = which === "official" ? cfg.officialPath : cfg.sandboxPath;
  const error = await launcher.openFolder(target);
  if (error) throw new Error(error);
  return true;
});

ipcMain.handle("health:run", async () => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Create the LSPDFR folder first.");
  const tests = health.runChecks(cfg.sandboxPath, cfg.officialPath, { dataDir: smartDataDir() });
  log(tests.verdict === "blocked" ? "error" : tests.verdict === "caution" ? "warn" : "ok", tests.summary);
  return { tests, state: snapshot() };
});

ipcMain.handle("health:crashes", async () => {
  const cfg = config.load(userData());
  return health.collectReports(cfg.sandboxPath);
});

ipcMain.handle("health:fixBattlEye", async () => {
  const cfg = config.load(userData());
  const result = battleye.setOff({ sandboxPath: cfg.sandboxPath, officialPath: cfg.officialPath });
  log("ok", "BattlEye is off for Story Mode (command line + Steam launch options).");
  return { ...result, state: snapshot() };
});

ipcMain.handle("folder:openPath", async (_event, target) => {
  if (!target) throw new Error("No path to open.");
  const error = await launcher.openFolder(target);
  if (error) throw new Error(error);
  return true;
});

// ---- V6: personal knowledge, update intelligence, health, diagnostics ----

function resolveKnowledgeKey({ installId, canonicalModId }) {
  const entry = userKnowledge.getEntry(smartDataDir(), { installId, canonicalModId });
  return (entry && entry.key) || installId || canonicalModId;
}

ipcMain.handle("knowledge:get", async (_event, { installId, canonicalModId } = {}) => {
  const manifest = installId ? require("./services/manifestStore").read(smartDataDir(), installId) : null;
  const userEntry = userKnowledge.getEntry(smartDataDir(), { installId, canonicalModId: canonicalModId || (manifest && manifest.canonicalModId) });
  const builtIn = modKnowledge.findById(builtInKnowledge(), canonicalModId || (manifest && manifest.canonicalModId));
  const resolved = userKnowledge.resolveMod({ mod: manifest || { installId, canonicalModId }, userEntry, builtIn });
  return { entry: userEntry, resolved };
});

ipcMain.handle("knowledge:set", async (_event, { key, installId, canonicalModId, patch } = {}) => {
  const target = key || resolveKnowledgeKey({ installId, canonicalModId }) || installId || canonicalModId;
  if (!target) throw new Error("A mod is required to save local metadata.");
  return userKnowledge.setEntry(smartDataDir(), target, patch || {});
});

ipcMain.handle("knowledge:markKnownGoodVersion", async (_event, { installId, canonicalModId, version } = {}) => {
  const target = resolveKnowledgeKey({ installId, canonicalModId }) || installId || canonicalModId;
  if (!target) throw new Error("A mod is required.");
  return userKnowledge.markKnownGoodVersion(smartDataDir(), target, version);
});

ipcMain.handle("knowledge:clear", async (_event, key) => userKnowledge.removeEntry(smartDataDir(), key));

ipcMain.handle("update:versionHistory", async (_event, installId) => updateIntelligence.versionHistory(v6Context(), installId));

ipcMain.handle("update:knownGoodPlan", async (_event, installId) => updateIntelligence.planKnownGoodRestore(v6Context(), installId));

ipcMain.handle("update:restoreKnownGood", async (_event, installId) => {
  const result = await updateIntelligence.restoreKnownGoodVersion(v6Context(), installId, {
    beforeRestore: () => {
      try {
        snapshotManager.create(v6Context(), { reason: snapshotManager.REASONS.BEFORE_DOWNGRADE });
      } catch {
        /* snapshot must not block a rollback */
      }
    },
  });
  try {
    profileManager.markDrifted(v5Context(), [`Restored known-good version of ${installId}`]);
  } catch {
    /* ignore */
  }
  return { ...result, state: snapshot() };
});

ipcMain.handle("mods:health", async () => modHealthList());

ipcMain.handle("mods:details", async (_event, installId) => {
  const cfg = config.load(userData());
  const manifest = require("./services/manifestStore").read(smartDataDir(), installId);
  const mod = managedList().find((row) => row.id === installId) || manifest;
  const sessions = fullSessions(40);
  const profiles = profileStore.listProfiles(profileRoot());
  const health = mod
    ? modHealthV2.evaluateModHealth(mod, {
        diagnosis: cfg.sandboxPath && exists(cfg.sandboxPath) ? diagnoseManagedMod(mod, { dutyPath: cfg.sandboxPath, dataDir: smartDataDir() }) : null,
        sessions,
        profiles,
        runtime: runtimeCompatibility.getEvidence(smartDataDir(), mod),
      })
    : null;
  const graph = dependencyGraph.build({ mods: managedList(), database: builtInKnowledge() });
  const userEntry = userKnowledge.getEntry(smartDataDir(), { installId, canonicalModId: manifest && manifest.canonicalModId });
  const builtIn = modKnowledge.findById(builtInKnowledge(), manifest && manifest.canonicalModId);
  return {
    installId,
    manifest,
    mod,
    health,
    dependencies: dependencyGraph.forwardTree(graph, installId),
    dependents: dependencyGraph.impactOfDisabling(graph, installId),
    versionHistory: updateIntelligence.versionHistory(v6Context(), installId),
    knownGoodPlan: updateIntelligence.planKnownGoodRestore(v6Context(), installId),
    knowledge: userKnowledge.resolveMod({ mod: mod || manifest || { installId }, userEntry, builtIn }),
    userEntry,
    configs: cfg.sandboxPath ? configIntelligence.describeManagedConfigs(mod || manifest || { id: installId, files: [] }, { dutyPath: cfg.sandboxPath, dataDir: smartDataDir() }) : [],
    keybinds: keybindReader.readKeybinds({
      mod: mod || {},
      manifest: manifest || {},
      dutyPath: cfg.sandboxPath || "",
      canonicalModId: (manifest && manifest.canonicalModId) || (mod && mod.canonicalModId) || "",
    }),
  };
});

ipcMain.handle("mods:search", async (_event, { query = "", filters = {} } = {}) => {
  const mods = managedList();
  const knowledgeById = new Map((builtInKnowledge().mods || []).map((entry) => [entry.id, entry]));
  const userDb = userKnowledge.load(smartDataDir());
  const userKnowledgeById = new Map(Object.entries(userDb.mods || {}));
  const healthById = new Map(modHealthList().map((row) => [row.installId, row]));
  const profiles = profileStore.listProfiles(profileRoot());
  const context = { knowledgeById, userKnowledgeById, healthById, profiles };
  let rows = modSearch.search(mods, query, context);
  rows = modSearch.filter(rows, filters, context);
  return rows;
});

ipcMain.handle("deps:graph", async () => {
  const graph = dependencyGraph.build({ mods: managedList(), database: builtInKnowledge() });
  return {
    nodes: graph.nodes,
    forward: graph.nodes.map((node) => dependencyGraph.forwardTree(graph, node.installId)),
    orphans: dependencyGraph.orphans(graph),
  };
});

ipcMain.handle("deps:impact", async (_event, installId) => {
  const graph = dependencyGraph.build({ mods: managedList(), database: builtInKnowledge() });
  return {
    dependents: dependencyGraph.impactOfDisabling(graph, installId),
    requiredDependents: dependencyGraph.requiredDependents(graph, installId),
  };
});

ipcMain.handle("deps:offers", async (_event, payload = {}) => {
  if (Array.isArray(payload.dependencies)) return dependencyDownload.offersFor(payload.dependencies);
  return dependencyDownload.offersForNames(payload.names || []);
});

ipcMain.handle("deps:openPage", async (_event, url) => {
  if (!dependencyDownload.isPageUrlAllowed(url)) {
    throw new Error("That page is not on the allowed official host list.");
  }
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("deps:downloadInstall", async (_event, payload = {}) => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Finish setup before installing dependencies.");
  const modId = payload.modId || payload.id;
  if (dependencyDownload.isBlockedId(modId)) {
    throw new Error("That component cannot be downloaded by the manager.");
  }
  const destDir = path.join(userData(), "dep-downloads", String(modId || "dep").replace(/[^\w.-]+/g, "_"));
  send("progress", { done: 0, total: 4, file: "Looking up official release…" });
  let downloaded;
  try {
    downloaded = await dependencyDownload.downloadTo({
      modId,
      destDir,
      extractArchive: installer.extractArchive,
    });
  } catch (error) {
    throw smartUserError(error);
  }
  send("progress", { done: 2, total: 4, file: `Installing ${downloaded.item.name} into Duty…` });
  let preview;
  try {
    preview = await smartInstall.analyze({
      source: downloaded.path,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      stagingRoot: smartStagingRoot(),
      officialPath: cfg.officialPath,
      lookupGuides: false,
    });
  } catch (error) {
    throw smartUserError(error);
  }
  const status = (preview.recommendation && preview.recommendation.status) || "";
  if (status === "BLOCKED" || status === "UNSUPPORTED") {
    if (preview.stagingDir) await smartInstall.discardStaging(preview.stagingDir);
    throw new Error(
      (preview.recommendation.reasons && preview.recommendation.reasons[0]) ||
        `${downloaded.item.name} could not be installed safely.`
    );
  }
  send("progress", { done: 3, total: 4, file: `Writing ${downloaded.item.name}…` });
  try {
    const manifest = await smartInstall.commit({
      preview,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      officialPath: cfg.officialPath,
      checkRunning: true,
      onProgress: (progress) => send("progress", progress),
    });
    try {
      profileManager.markDrifted(v5Context(), [`${manifest.name} was installed as a dependency`]);
    } catch {
      /* drift tracking must not block */
    }
    log("ok", `Installed ${downloaded.item.name} into the Duty folder.`);
    send("progress", { done: 4, total: 4, file: downloaded.item.name });
    return { ok: true, name: downloaded.item.name, files: downloaded.files, manifest };
  } catch (error) {
    if (preview.stagingDir) await smartInstall.discardStaging(preview.stagingDir);
    throw smartUserError(error);
  }
});

ipcMain.handle("dashboard:get", async () => {
  const cfg = config.load(userData());
  const tests = cfg.sandboxPath && exists(cfg.sandboxPath) ? health.runChecks(cfg.sandboxPath, cfg.officialPath, { dataDir: smartDataDir() }) : null;
  const modHealth = modHealthList();
  const profile = (() => {
    try {
      return profileManager.activeSummary(v5Context());
    } catch {
      return null;
    }
  })();
  const missing = missingRequiredDeps();
  const dutyHealth = dutyHealthV2.summarize({ tests, modHealth, profile, overlays: overlays.overlayStatus(), missingRequiredDeps: missing });
  const alerts = dutyHealthV2.priorityAlerts({ tests, modHealth, profile, missingRequiredDeps: missing });
  const counts = modHealthV2.summarizeCounts(modHealth);
  const recentChanges = smartAudit.readAudit(smartDataDir(), 6).reverse();
  return {
    dutyHealth,
    alerts,
    counts,
    recentChanges,
    startupSummary: dutyHealthV2.startupSummary({ dutyFound: Boolean(cfg.sandboxPath && exists(cfg.sandboxPath)), profile, tests, modCount: modHealth.length, lastSession: lastSessionSummary() }),
    appHealth: selfCheck.run(v6Context()).appHealth,
  };
});

ipcMain.handle("smart:readiness", async () => smartReadiness.evaluate(smartAudit.readMetrics(smartDataDir())));

ipcMain.handle("smart:presets", async () => smartReadiness.PRESETS);

ipcMain.handle("troubleshoot:run", async () => {
  const cfg = config.load(userData());
  const tests = cfg.sandboxPath && exists(cfg.sandboxPath) ? health.runChecks(cfg.sandboxPath, cfg.officialPath, { dataDir: smartDataDir() }) : null;
  const profile = (() => {
    try {
      return profileManager.activeSummary(v5Context());
    } catch {
      return null;
    }
  })();
  let lastCrashAnalysis = null;
  try {
    const last = lastSessionSummary();
    if (last && last.sessionId) lastCrashAnalysis = crashAnalyzer.getAnalysis(sessionRoot(), last.sessionId);
  } catch {
    lastCrashAnalysis = null;
  }
  return troubleshoot.run({ tests, profile, modHealth: modHealthList(), missingRequiredDeps: missingRequiredDeps(), lastCrashAnalysis });
});

ipcMain.handle("diagnostics:selfCheck", async () => selfCheck.run(v6Context()));

ipcMain.handle("diagnostics:audit", async (_event, limit = 50) => smartAudit.readAudit(smartDataDir(), limit).reverse());

ipcMain.handle("diagnostics:export", async () => {
  const chosen = await dialog.showOpenDialog(win, { title: "Choose a folder for the diagnostic report", properties: ["openDirectory", "createDirectory"] });
  if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
  const cfg = config.load(userData());
  const dest = path.join(chosen.filePaths[0], `duty-diagnostics-${Date.now()}`);
  const report = diagnosticsReport.buildReport(
    {
      appVersion: pkg.version,
      appHealth: selfCheck.run(v6Context()).appHealth,
      dutyHealth: snapshot().dutyHealth,
      activeProfile: (() => {
        const s = (() => {
          try {
            return profileManager.activeSummary(v5Context());
          } catch {
            return null;
          }
        })();
        return s && s.profile ? { name: s.profile.name, knownGood: s.profile.knownGood, drifted: s.profile.drifted } : null;
      })(),
      environment: null,
      mods: managedList(),
      dependencies: dependencyGraph.build({ mods: managedList(), database: builtInKnowledge() }).nodes.length,
      lastSession: lastSessionSummary(),
      logs: cfg.sandboxPath ? health.collectReports(cfg.sandboxPath).logs : [],
      launchInvariants: cfg.sandboxPath ? { ok: health.verifyLaunchIntegrity(cfg.sandboxPath, cfg.officialPath).ok !== false } : null,
    },
    { home: app.getPath("home"), username: path.basename(app.getPath("home")) }
  );
  diagnosticsReport.writeReport(dest, report, { home: app.getPath("home"), username: path.basename(app.getPath("home")) });
  return { path: dest, report };
});

ipcMain.handle("session:filter", async (_event, { type = "All", profileId = "", installId = "" } = {}) => {
  const sessions = getSessions().getRecentSessions(60);
  return sessionFilter.filterSessions(sessions, { type, profileId, installId });
});

ipcMain.handle("storage:usage", async () => storageManager.usage(v6Context()));

ipcMain.handle("storage:cleanupPlan", async () => storageManager.planCleanup(v6Context()));

ipcMain.handle("storage:cleanupApply", async (_event, ids) => {
  const result = storageManager.applyCleanup(v6Context(), ids || []);
  return { ...result, usage: storageManager.usage(v6Context()) };
});

ipcMain.handle("backup:export", async () => {
  const chosen = await dialog.showOpenDialog(win, { title: "Choose a folder for the manager backup", properties: ["openDirectory", "createDirectory"] });
  if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
  const dest = path.join(chosen.filePaths[0], `mod-manager-backup-${Date.now()}`);
  const manifest = managerBackup.exportBackup(v6Context(), dest);
  return { path: dest, manifest };
});

ipcMain.handle("backup:importPlan", async () => {
  const chosen = await dialog.showOpenDialog(win, { title: "Choose a manager backup folder", properties: ["openDirectory"] });
  if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true };
  return { dir: chosen.filePaths[0], plan: managerBackup.planImport(chosen.filePaths[0], v6Context()) };
});

ipcMain.handle("backup:importApply", async (_event, { dir, options } = {}) => {
  if (!dir) throw new Error("No backup folder selected.");
  const result = managerBackup.applyImport(dir, v6Context(), options || {});
  return { ...result, state: snapshot() };
});

ipcMain.handle("profile:recommendation", async (_event, profileId) => {
  const profile = profileStore.getProfile(profileRoot(), profileId);
  return profileRecommendation.recommend(profile, fullSessions(60));
});

ipcMain.handle("config:describe", async (_event, installId) => {
  const cfg = config.load(userData());
  const mod = managedList().find((row) => row.id === installId) || require("./services/manifestStore").read(smartDataDir(), installId);
  return configIntelligence.describeManagedConfigs(mod || { id: installId, files: [] }, { dutyPath: cfg.sandboxPath, dataDir: smartDataDir() });
});

ipcMain.handle("config:diff", async (_event, { installId, destination } = {}) => {
  const cfg = config.load(userData());
  const mod = managedList().find((row) => row.id === installId) || require("./services/manifestStore").read(smartDataDir(), installId);
  return configIntelligence.diffAgainstDefault(mod || { id: installId }, destination, { dutyPath: cfg.sandboxPath, dataDir: smartDataDir() });
});

ipcMain.handle("config:restoreDefault", async (_event, { installId, destination } = {}) => {
  const cfg = config.load(userData());
  const result = configIntelligence.restoreDefault({ dutyPath: cfg.sandboxPath, dataDir: smartDataDir() }, installId, destination);
  return { ...result, state: snapshot() };
});

ipcMain.handle("logs:list", async () => {
  const cfg = config.load(userData());
  return logViewer.listLogs({ dutyPath: cfg.sandboxPath, dataDir: smartDataDir(), sessionRoot: sessionRoot() });
});

ipcMain.handle("logs:read", async (_event, { filePath, tailLines, search } = {}) => {
  const allowed = logViewer.listLogs({ dutyPath: config.load(userData()).sandboxPath, dataDir: smartDataDir(), sessionRoot: sessionRoot() });
  if (!allowed.some((row) => row.path === filePath)) throw new Error("That log is not available.");
  return logViewer.readLog(filePath, { tailLines, search });
});

ipcMain.handle("session:compareLastClean", async (_event, sessionId) => {
  const session = getSessions().getSession(sessionId);
  if (!session) throw new Error("Session not found.");
  const history = getSessions()
    .getRecentSessions(40)
    .map((row) => getSessions().getSession(row.sessionId))
    .filter(Boolean);
  return compareSessions(session, history);
});

ipcMain.handle("settings:get", async () => config.load(userData()));

ipcMain.handle("settings:save", async (_event, patch = {}) => {
  const allowed = [
    "defaultProfileId",
    "snapshotBeforeUpdate",
    "snapshotBeforeRiskyInstall",
    "smartPreviewDefault",
    "sessionRetention",
    "autoSnapshotRetention",
    "openLastPage",
    "lastPage",
    "developerMode",
    "theme",
    "lookupInstallGuides",
    "aiGuideEnabled",
    "aiApiKey",
    "aiApiUrl",
  ];
  const clean = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) clean[key] = patch[key];
  }
  if (Object.prototype.hasOwnProperty.call(clean, "theme")) {
    clean.theme = clean.theme === "bright" ? "bright" : "dark";
  }
  if (Object.prototype.hasOwnProperty.call(clean, "aiApiUrl")) {
    const url = String(clean.aiApiUrl || "").trim();
    clean.aiApiUrl = url && /^https:\/\//i.test(url) ? url : "";
  }
  if (Object.prototype.hasOwnProperty.call(clean, "aiApiKey") && !String(clean.aiApiKey || "").trim()) {
    delete clean.aiApiKey;
  }
  const saved = config.save(userData(), clean);
  return { config: saved, state: snapshot() };
});
