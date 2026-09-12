const { app, BrowserWindow, ipcMain, dialog, clipboard } = require("electron");
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

let win = null;
const pendingPlans = new Map();
const smartPlans = new Map();
let logWatch = null;

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
    title: "GTA 5 Mod Manager",
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
  const game = sandbox.status(cfg.officialPath, cfg.sandboxPath);
  const rawMods = cfg.sandboxPath && exists(cfg.sandboxPath) ? registry.load(cfg.sandboxPath).mods : [];
  const tests =
    cfg.sandboxPath && exists(cfg.sandboxPath)
      ? health.runChecks(cfg.sandboxPath, cfg.officialPath)
      : null;
  const mods = cfg.sandboxPath ? health.withModStatus(cfg.sandboxPath, rawMods) : rawMods;
  return { config: cfg, game, mods, tests };
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  stopLogWatch();
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

ipcMain.handle("smart:analyze", async (_event, sourcePath) => {
  const cfg = config.load(userData());
  if (!cfg.sandboxPath) throw new Error("Finish setup before installing mods.");
  const label = path.basename(sourcePath);
  log("info", `Smart Install: analyzing ${label}…`);
  const preview = await smartInstall.analyze({
    source: sourcePath,
    dutyPath: cfg.sandboxPath,
    dataDir: smartDataDir(),
    stagingRoot: smartStagingRoot(),
    officialPath: cfg.officialPath,
    legacyOwnersOf: (destRel) => registry.ownersOf(cfg.sandboxPath, destRel),
  });
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
});

ipcMain.handle("smart:commit", async (_event, planId) => {
  const preview = smartPlans.get(planId);
  if (!preview) throw new Error("That install preview expired. Drop the archive again.");
  const cfg = config.load(userData());
  log("info", `Smart Install: installing ${preview.name}…`);
  try {
    const manifest = await smartInstall.commit({
      preview,
      dutyPath: cfg.sandboxPath,
      dataDir: smartDataDir(),
      onProgress: (progress) => send("progress", progress),
    });
    smartPlans.delete(planId);
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
    throw error;
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

ipcMain.handle("smart:list", async () => smartInstall.list(smartDataDir()));

ipcMain.handle("smart:uninstall", async (_event, modId) => {
  const cfg = config.load(userData());
  const result = await smartInstall.uninstall({
    modId,
    dutyPath: cfg.sandboxPath,
    dataDir: smartDataDir(),
  });
  log("ok", `Smart Install: removed mod (${result.restored} restored, ${result.removed} removed, ${result.kept} kept for other mods).`);
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
  const result = await launcher.launchLspdfr({
    sandboxPath: cfg.sandboxPath,
    officialPath: cfg.officialPath,
  });
  log("ok", "Launching Rage Plugin Hook. If Windows asks for permission, click Yes.");
  log("info", "Steam may ask to launch with custom arguments (-skipPatchChecker -launchTitleInFolder). Click Play. That keeps Story Mode in the LSPDFR folder.");
  log("info", "Do not click Cancel, and do not start the game from the Steam library.");
  startLogWatch(cfg.sandboxPath);
  return result;
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
  const tests = health.runChecks(cfg.sandboxPath, cfg.officialPath);
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
