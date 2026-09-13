const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { exists, isEnhancedFolder, ENHANCED_EXE, RPH_EXE } = require("./paths");
const { unregisteredPacks } = require("./dlclist");
const registry = require("./registry");
const { verifyLaunchIntegrity } = require("./launchguard");
const overlays = require("./overlays");
const launchArgs = require("./launchArgs");
const dutyWarnings = require("./knowledge/dutyWarnings");

function fileIn(root, ...parts) {
  return path.join(root || "", ...parts);
}

function has(root, ...parts) {
  return Boolean(root) && exists(fileIn(root, ...parts));
}

function check(id, ok, level, title, detail) {
  return { id, ok, level: ok ? "ok" : level, title, detail };
}

function processRunning(image) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return new RegExp(image.replace(/\./g, "\\."), "i").test(out);
  } catch {
    return false;
  }
}

function enabledMods(sandboxPath) {
  return registry.load(sandboxPath).mods.filter((mod) => mod.enabled !== false);
}

function kindsFromMods(mods) {
  const kinds = new Set();
  for (const mod of mods) {
    for (const kind of mod.kinds || []) kinds.add(kind);
  }
  return kinds;
}

function conflictChecks(sandboxPath) {
  const owners = new Map();
  for (const mod of enabledMods(sandboxPath)) {
    for (const rel of mod.files || []) {
      const key = String(rel).replace(/\//g, "\\").toLowerCase();
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(mod.name);
    }
  }
  const clashes = [...owners.entries()]
    .filter(([, names]) => new Set(names).size > 1)
    .slice(0, 8);
  if (!clashes.length) {
    return [check("conflicts", true, "warn", "File conflicts", "Enabled mods do not overwrite each other.")];
  }
  return [
    check(
      "conflicts",
      false,
      "warn",
      "File conflicts",
      clashes.map(([file, names]) => `${names.join(" + ")} both own ${file}`).join(" · ")
    ),
  ];
}

function summarizeModCompatibility(dataDir) {
  if (!dataDir) return null;
  let mods = [];
  try {
    mods = require("./manifestStore").list(dataDir).filter((mod) => mod.enabled !== false);
  } catch {
    return null;
  }
  if (!mods.length) return null;
  let verified = 0;
  let unknown = 0;
  let warning = 0;
  let incompatible = 0;
  for (const mod of mods) {
    const status = String(mod.compatibilityStatus || mod.compatibility || "UNKNOWN").toUpperCase();
    if (status === "VERIFIED" || status === "LIKELY_COMPATIBLE") verified += 1;
    else if (status === "INCOMPATIBLE") incompatible += 1;
    else if (status === "WARNING") warning += 1;
    else unknown += 1;
  }
  const detail = `✓ ${verified} likely/verified · ⚠ ${unknown} unknown · ⚠ ${warning} warnings · ✕ ${incompatible} incompatible`;
  return check("mod-compatibility", incompatible === 0, incompatible ? "warn" : "ok", "Mod compatibility", detail);
}

function runChecks(sandboxPath, officialPath, options = {}) {
  const checks = [];
  const mods = sandboxPath && exists(sandboxPath) ? enabledMods(sandboxPath) : [];
  const kinds = kindsFromMods(mods);

  checks.push(
    check(
      "enhanced",
      isEnhancedFolder(sandboxPath),
      "bad",
      "GTA V Enhanced",
      isEnhancedFolder(sandboxPath)
        ? `${ENHANCED_EXE} is in the LSPDFR folder.`
        : "Create the LSPDFR folder in Setup first."
    )
  );

  const hasRage = has(sandboxPath, RPH_EXE);
  checks.push(
    check(
      "rph",
      hasRage,
      "bad",
      "Rage Plugin Hook",
      hasRage
        ? "RagePluginHook.exe is ready. Use Play LSPDFR and stay in Story Mode."
        : "Drop the LSPDFR Enhanced Preview archive before launching duty."
    )
  );

  const lspdfrDll =
    has(sandboxPath, "plugins", "LSPDFR.dll") ||
    has(sandboxPath, "plugins", "LSPD First Response.dll");
  if (hasRage || kinds.has("lspdfr")) {
    checks.push(
      check(
        "lspdfr",
        lspdfrDll,
        "bad",
        "LSPDFR",
        lspdfrDll
          ? "LSPD First Response is installed in Plugins."
          : "LSPD First Response.dll is missing from plugins."
      )
    );
  }

  if (sandboxPath) {
    const guard = verifyLaunchIntegrity(sandboxPath, officialPath);
    const already = new Set(checks.map((row) => row.id));
    for (const row of guard.checks) {
      if (already.has(row.id)) continue;
      if (
        [
          "lspdfr-plugin",
          "root-deps",
          "plugins-clean",
          "no-newtonsoft",
          "startup-rphs",
          "online-clean",
          "install-mapping",
        ].includes(row.id)
      ) {
        checks.push(row);
        already.add(row.id);
      }
    }
  }

  const commandline = has(sandboxPath, "commandline.txt")
    ? fs.readFileSync(fileIn(sandboxPath, "commandline.txt"), "utf8")
    : "";
  const beOff = /(?:^|\s)-nobattleye\b/i.test(commandline);
  checks.push(
    check(
      "battleye",
      beOff || !has(sandboxPath, "BattlEye"),
      "warn",
      "BattlEye",
      beOff
        ? "commandline.txt disables BattlEye for Story Mode."
        : "Story Mode mods crash if BattlEye is on. Add -nobattleye to commandline.txt in the LSPDFR folder."
    )
  );

  const perms =
    exists(fileIn(sandboxPath, ".tactix", "windows-permissions.ok")) || dutySessionLooksGood(sandboxPath);
  checks.push(
    check(
      "permissions",
      perms,
      "warn",
      "Windows / Steam access",
      perms
        ? "Rage Plugin Hook is already hooking the duty folder. Windows permission prompts are not blocking play."
        : "Play LSPDFR will ask Windows once to allow the duty folder, Steam, and the game."
    )
  );

  const cortex = processRunning("RazerCortex.exe");
  checks.push(
    check(
      "cortex",
      !cortex,
      "warn",
      "Razer Cortex",
      cortex
        ? "Razer Cortex is running. It often blocks Rage Plugin Hook with an anti-virus / permissions error. Play LSPDFR will close it."
        : "Razer Cortex is not running."
    )
  );

  const overlay = overlays.overlayStatus();
  checks.push(
    check(
      "overlays",
      !overlay.nvidiaOverlay,
      "warn",
      "NVIDIA Overlay",
      overlay.nvidiaOverlay
        ? "NVIDIA Overlay is running. It hooks DirectX and can crash Rage Plugin Hook inside Social Club. Play LSPDFR will close it during launch. Turn off In-Game Overlay in NVIDIA App to keep it off."
        : "NVIDIA Overlay is not running."
    )
  );

  const hasDsFix = has(sandboxPath, "DirectStorageFix.asi");
  const skippedDs = has(sandboxPath, "skipdscheck");
  const asiLoader = has(sandboxPath, "dinput8.dll") || has(sandboxPath, "xinput1_4.dll");
  checks.push(
    check(
      "directstorage",
      hasDsFix && asiLoader,
      "warn",
      "DirectStorage",
      hasDsFix && asiLoader
        ? "DirectStorageFix.asi and an ASI loader are installed."
        : hasDsFix
          ? "DirectStorageFix.asi is present but needs dinput8.dll (ASI loader) or it will not run."
          : skippedDs
            ? "RPH skipdscheck is present. Install DirectStorageFix.asi plus an ASI loader for the real fix."
            : "Rage Plugin Hook needs DirectStorageFix and an ASI loader in the duty folder."
    )
  );

  const extraAsi = (sandboxPath ? listRootAsi(sandboxPath) : []).filter(
    (name) => !/^directstoragefix\.asi$/i.test(name)
  );
  if (extraAsi.length) {
    const loader = has(sandboxPath, "dinput8.dll") && has(sandboxPath, "ScriptHookV.dll");
    checks.push(
      check(
        "scripthook",
        loader,
        "warn",
        "ScriptHookV",
        loader
          ? "dinput8.dll and ScriptHookV.dll are present for ASI scripts."
          : `${extraAsi.join(", ")} need ScriptHookV + dinput8.dll. DirectStorageFix and LSPDFR do not.`
      )
    );
  }

  const usesModsFolder =
    has(sandboxPath, "mods") ||
    mods.some((mod) => (mod.files || []).some((file) => /^mods[\\/]/i.test(file)));
  if (usesModsFolder) {
    checks.push(
      check(
        "openiv",
        has(sandboxPath, "OpenIV.asi"),
        "warn",
        "OpenIV.asi",
        has(sandboxPath, "OpenIV.asi")
          ? "OpenIV.asi will load the mods folder."
          : "A mods folder is present but OpenIV.asi is missing, so replacements will not load."
      )
    );
  }

  const usesLml =
    has(sandboxPath, "lml") ||
    mods.some((mod) => (mod.kinds || []).includes("lml") || (mod.files || []).some((file) => /^lml[\\/]/i.test(file)));
  if (usesLml) {
    const lmlOk =
      has(sandboxPath, "lml.asi") ||
      has(sandboxPath, "vfs.asi") ||
      has(sandboxPath, "LenmysModLoader.asi") ||
      has(sandboxPath, "lml", "lml.asi");
    checks.push(
      check(
        "lml",
        lmlOk,
        "warn",
        "Lenny's Mod Loader",
        lmlOk
          ? "LML / VFS is present."
          : "LML packages are installed but lml.asi / vfs.asi was not found, so those buildings and cars may not mount."
      )
    );
  }

  if (kinds.has("els") || has(sandboxPath, "ELS")) {
    checks.push(
      check(
        "els",
        has(sandboxPath, "ELS.asi") || has(sandboxPath, "AdvancedHookV.dll"),
        "warn",
        "ELS",
        has(sandboxPath, "ELS.asi")
          ? "ELS.asi is installed."
          : "ELS XML files are present but ELS.asi was not found."
      )
    );
  }

  if (kinds.has("uniform")) {
    const eup =
      has(sandboxPath, "EUP Menu.asi") ||
      has(sandboxPath, "EUPMenu.asi") ||
      has(sandboxPath, "plugins", "EUP") ||
      has(sandboxPath, "lspdfr", "data", "wardrobe.ini");
    checks.push(
      check(
        "eup",
        eup,
        "warn",
        "Uniforms / EUP",
        eup
          ? "Wardrobe / EUP files are present."
          : "Uniform packs usually need EUP and a wardrobe.ini before they appear on duty."
      )
    );
  }

  const dlc = sandboxPath ? unregisteredPacks(sandboxPath, officialPath) : { extras: [], missing: [] };
  if (dlc.extras.length) {
    checks.push(
      check(
        "dlclist",
        dlc.missing.length === 0,
        "bad",
        "Addon DLC list",
        dlc.missing.length
          ? `Not in dlclist.xml: ${dlc.missing.join(", ")}. Cars and maps in those packs will not spawn.`
          : `${dlc.extras.length} addon pack(s) are registered.`
      )
    );
  }

  if (dlc.extras.length >= 2) {
    const heap = has(sandboxPath, "HeapAdjuster.asi") || has(sandboxPath, "PackfileLimitAdjuster.asi");
    const gameconfig =
      has(sandboxPath, "mods", "update", "update.rpf", "common", "data", "gameconfig.xml") ||
      mods.some((mod) => (mod.kinds || []).includes("gameconfig"));
    checks.push(
      check(
        "heap",
        heap,
        "warn",
        "Heap / packfile limit",
        heap
          ? "Heap or packfile adjuster is installed."
          : "Several addon packs are installed. Add HeapAdjuster and PackfileLimitAdjuster to avoid random crashes."
      )
    );
    checks.push(
      check(
        "gameconfig",
        gameconfig,
        "warn",
        "Gameconfig",
        gameconfig
          ? "A custom gameconfig is installed."
          : "Addon cars and maps are more stable with a raised Enhanced gameconfig in the mods folder."
      )
    );
  }

  if (sandboxPath) checks.push(...conflictChecks(sandboxPath));

  const warningScan = dutyWarnings.functionTestChecks(sandboxPath);
  checks.push(...warningScan.checks);

  const compat = summarizeModCompatibility(options.dataDir || "");
  if (compat) checks.push(compat);

  const last = summarizeCrash(sandboxPath);
  if (last) {
    checks.push(check("last-crash", false, "bad", "Last crash", last.summary));
  } else if (hasRage) {
    checks.push(check("last-crash", true, "ok", "Last crash", "No crash signature in recent Rage Plugin Hook logs."));
  }

  const failed = checks.filter((item) => !item.ok);
  const blocking = failed.filter((item) => item.level === "bad").length;
  const warnings = failed.filter((item) => item.level === "warn").length;
  let verdict = "ready";
  let summary = "Function test passed. Core files look ready for Story Mode.";
  if (blocking) {
    verdict = "blocked";
    summary = `${blocking} blocking issue(s) will likely crash or prevent a launch.`;
  } else if (warnings) {
    verdict = "caution";
    const titles = failed.filter((item) => item.level === "warn").map((item) => item.title);
    summary = `${warnings} warning(s): ${titles.join(", ")}.`;
  }

  return {
    verdict,
    summary,
    blocking,
    warnings,
    passed: checks.filter((item) => item.ok).length,
    total: checks.length,
    checks,
    dlc,
    dutyWarnings: warningScan ? warningScan.dutyWarnings : [],
  };
}

const LOG_NAMES = [
  "RagePluginHook.log",
  "asiload.log",
  "asilog.txt",
  "ScriptHookV.log",
  "ELS.log",
  "OpenIV.log",
];

const CRASH_LINE = /error|exception|fatal|crash|terminated|failed to load|could not|missing/i;
const NOISE_LINE =
  /errorcode|error codes|0 error|address mismatch|specified twice|failed to parse\s+as chance|getoutfitvariation|cannot create an abstract class|attempted to start callout|notimplementedexception|backupmanager\.cs|\[d3d12\]/i;

function readTail(file, maxBytes = 80_000) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const start = Math.max(0, stat.size - maxBytes);
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    if (!isTextBuffer(buf)) return null;
    return { text: buf.toString("utf8"), mtime: stat.mtime.toISOString(), size: stat.size };
  } catch {
    return null;
  }
}

function interestingLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && CRASH_LINE.test(line) && !NOISE_LINE.test(line))
    .slice(-12);
}

function dutySessionLooksGood(sandboxPath) {
  try {
    const text = fs.readFileSync(fileIn(sandboxPath, "RagePluginHook.log"), "utf8");
    return /Loading plugin from path:.*LSPD First Response\.dll/i.test(text) && !/Failed to load plugin/i.test(text);
  } catch {
    return false;
  }
}

function listRootAsi(sandboxPath) {
  try {
    return fs
      .readdirSync(sandboxPath)
      .filter((name) => /\.asi$/i.test(name))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function isTextBuffer(buf) {
  if (!buf.length) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  if (sample.includes(0)) return false;
  let control = 0;
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / sample.length < 0.08;
}

function extraLogDirs() {
  const home = os.homedir();
  return [
    path.join(home, "Documents", "Rockstar Games", "GTA V Enhanced"),
    path.join(home, "Documents", "Rockstar Games", "GTAV Enhanced"),
  ];
}

function collectLogs(sandboxPath) {
  const logs = [];
  const seen = new Set();

  function add(file) {
    if (!file || !exists(file) || seen.has(file.toLowerCase())) return;
    seen.add(file.toLowerCase());
    if (/\.dmp$/i.test(file)) return;
    const tail = readTail(file);
    if (!tail) return;
    const errors = interestingLines(tail.text).filter((line) => line.length < 240 && /[A-Za-z]/.test(line));
    logs.push({
      name: path.basename(file),
      path: file,
      mtime: tail.mtime,
      size: tail.size,
      errors,
      excerpt: tail.text.split(/\r?\n/).filter((line) => line.length < 240).slice(-20).join("\n"),
    });
  }

  if (sandboxPath) {
    for (const name of LOG_NAMES) add(fileIn(sandboxPath, name));
    add(fileIn(sandboxPath, "plugins", "LSPDFR", "RagePluginHook.log"));
  }

  for (const dir of extraLogDirs()) {
    if (!exists(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (LOG_NAMES.some((log) => log.toLowerCase() === name.toLowerCase())) {
          add(path.join(dir, name));
        }
      }
    } catch {
      /* ignore */
    }
  }

  logs.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return logs;
}

function d3dHookDied(sandboxPath) {
  try {
    const text = fs.readFileSync(fileIn(sandboxPath, "RagePluginHook.log"), "utf8");
    const hooked = /\[d3d12\] Hooked/i.test(text);
    const started = /\[d3d12\] Hooking game swap chain/i.test(text);
    const failed = /\[d3d12\].{0,120}(?:failed|fatal|crash|device)/i.test(text);
    return started && !hooked && failed;
  } catch {
    return false;
  }
}

function summarizeCrash(sandboxPath) {
  if (d3dHookDied(sandboxPath)) {
    const file = fileIn(sandboxPath, "RagePluginHook.log");
    let at = null;
    try {
      at = fs.statSync(file).mtime.toISOString();
    } catch {
      at = null;
    }
    return {
      at,
      source: "RagePluginHook.log",
      path: file,
      summary:
        "Rage Plugin Hook crashed while hooking DirectX (Social Club D3D12). NVIDIA Overlay / NvCamera was injected. Play LSPDFR now closes those overlays during launch.",
      lines: ["[d3d12] Hooking game swap chain"],
    };
  }

  const logs = collectLogs(sandboxPath).filter((log) => log.errors.length);
  if (!logs.length) return null;
  const top = logs[0];
  let summary = top.errors[top.errors.length - 1];
  const blob = top.errors.join("\n");
  if (
    /LSPD First Response/i.test(blob) &&
    /FileNotFoundException|or one of its dependencies/i.test(blob) &&
    (has(sandboxPath, "plugins", "SlimDX.dll") || has(sandboxPath, "plugins", "LSPDFR", "SlimDX.dll")) &&
    has(sandboxPath, "plugins", "LSPD First Response.dll")
  ) {
    summary =
      "Old session: LSPDFR failed because support DLLs were not next to the game exe. Launch again after Play LSPDFR repairs the layout.";
  } else if (/WeaponSkin/i.test(blob) && /AccessViolationException/i.test(blob)) {
    summary =
      "LSPDFR crashed while going on duty (WeaponSkin). The plugin pack never loaded. This is not a missing-mod layout problem.";
  }
  return {
    at: top.mtime,
    source: top.name,
    path: top.path,
    summary,
    lines: top.errors,
  };
}

function collectReports(sandboxPath) {
  const logs = collectLogs(sandboxPath);
  const lastCrash = summarizeCrash(sandboxPath);
  const dumps = logs.filter((log) => /\.dmp$/i.test(log.name));
  return {
    lastCrash,
    logs: logs.filter((log) => !/\.dmp$/i.test(log.name)).slice(0, 8),
    dumps: dumps.slice(0, 6),
  };
}

function ensureNoBattlEye(sandboxPath) {
  if (!sandboxPath || !exists(sandboxPath)) {
    throw new Error("Create the LSPDFR folder first.");
  }
  const file = fileIn(sandboxPath, "commandline.txt");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = "";
  }
  if (/(?:^|\s)-nobattleye\b/i.test(current)) {
    launchArgs.removeFlagFromFile(fileIn(sandboxPath, "args.txt"));
    return { ok: true, file, changed: false };
  }
  const next = `${current.trim()}\n-nobattleye\n`.trimStart();
  fs.writeFileSync(file, next, "utf8");
  launchArgs.removeFlagFromFile(fileIn(sandboxPath, "args.txt"));
  return { ok: true, file, changed: true };
}

function parseNewFindings(previous, nextText) {
  const lines = String(nextText || "").split(/\r?\n/);
  const start = Number.isFinite(previous) && previous > 0 ? previous : 0;
  const fresh = lines.slice(start);
  const findings = [];
  for (const line of fresh) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/plugin ".+" was loaded|loaded successfully/i.test(trimmed)) {
      findings.push({ level: "ok", message: trimmed });
    } else if (/insufficient permissions|bad anti-virus|could not hook game process/i.test(trimmed)) {
      findings.push({
        level: "error",
        message:
          "Rage Plugin Hook could not hook GTA. Close the game, approve the Windows prompt, and try Play LSPDFR again.",
      });
    } else if (CRASH_LINE.test(trimmed) && !NOISE_LINE.test(trimmed)) {
      findings.push({ level: "error", message: trimmed });
    }
  }
  return { findings, lineCount: lines.length };
}

function withModStatus(sandboxPath, mods, extras = {}) {
  const modCondition = require("./knowledge/modCondition");
  return modCondition.attachLamps(mods, {
    dutyPath: sandboxPath,
    source: "FOLDER",
    sessions: extras.sessions || [],
    profiles: extras.profiles || [],
    runtimeDb: extras.runtimeDb || null,
    dataDir: extras.dataDir || "",
  });
}

module.exports = {
  runChecks,
  summarizeModCompatibility,
  collectReports,
  summarizeCrash,
  parseNewFindings,
  ensureNoBattlEye,
  verifyLaunchIntegrity,
  withModStatus,
};
