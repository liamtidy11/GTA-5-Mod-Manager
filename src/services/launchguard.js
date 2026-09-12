const fs = require("fs");
const path = require("path");
const { exists, isEnhancedFolder, ENHANCED_EXE, PLAY_EXE, RPH_EXE } = require("./paths");
const { RPH_ROOT_DLLS, buildPlanFiles } = require("./modtypes");

const REQUIRED_ROOT_DLLS = [
  "LMS.Common.dll",
  "DiscordRpcNet.dll",
  "DdsConvert.dll",
  "SlimDX.dll",
  "EasyHook.dll",
  "EasyHook64.dll",
];

const PLUGIN_ROOT_OK = new Set([
  "lspd first response.dll",
  "lspd first response.dll.config",
  "lspd first response.pdb",
]);

const OFFICIAL_FORBIDDEN = [
  "RagePluginHook.exe",
  "RAGEPluginHook.exe",
  path.join("plugins", "LSPD First Response.dll"),
  "DirectStorageFix.asi",
  "LSPD First Response.dll",
];

function fileIn(root, ...parts) {
  return path.join(root || "", ...parts);
}

function has(root, ...parts) {
  return Boolean(root) && exists(fileIn(root, ...parts));
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function item(id, ok, level, title, detail) {
  return { id, ok, level: ok ? "ok" : level, title, detail };
}

function pluginRootJunk(sandboxPath) {
  return listNames(fileIn(sandboxPath, "plugins")).filter((name) => {
    const lower = name.toLowerCase();
    if (lower === "lspdfr") return false;
    return !PLUGIN_ROOT_OK.has(lower);
  });
}

function findNewtonsoft(sandboxPath) {
  const hits = [];
  for (const rel of ["", "plugins", path.join("plugins", "LSPDFR"), "lspdfr"]) {
    const dir = fileIn(sandboxPath, rel);
    for (const name of listNames(dir)) {
      if (/newtonsoft\.json\.dll/i.test(name)) hits.push(path.join(rel, name).replace(/^[\\/]/, ""));
    }
  }
  return hits;
}

function verifyMapping() {
  const files = [
    "RAGEPluginHook.exe",
    "LMS.Common.dll",
    "DiscordRpcNet.dll",
    "DdsConvert.dll",
    "SlimDX.dll",
    "EasyHook.dll",
    path.join("plugins", "LSPD First Response.dll"),
  ];
  const mapped = buildPlanFiles({
    files,
    archiveName: "lspdfr_049_9695_setup.exe",
    payloadRoot: ".",
    assemblyCopies: [],
  });
  const dest = Object.fromEntries((mapped.copies || []).map((copy) => [path.basename(copy.from).toLowerCase(), copy.to]));
  const mustStayRoot = ["lms.common.dll", "discordrpcnet.dll", "ddsconvert.dll", "slimdx.dll", "easyhook.dll"];
  const leaked = mustStayRoot.filter((name) => /plugins/i.test(dest[name] || ""));
  const pluginDest = dest["lspd first response.dll"] || "";
  const pluginOk = /plugins[\\/]lspd first response\.dll$/i.test(pluginDest);
  return {
    ok: leaked.length === 0 && pluginOk,
    leaked,
    pluginDest,
  };
}

function verifyLaunchIntegrity(sandboxPath, officialPath) {
  const checks = [];

  checks.push(
    item(
      "duty-enhanced",
      isEnhancedFolder(sandboxPath),
      "bad",
      "Duty GTA V Enhanced",
      isEnhancedFolder(sandboxPath)
        ? `${ENHANCED_EXE} is in the LSPDFR folder.`
        : `${ENHANCED_EXE} is missing from the LSPDFR folder.`
    )
  );

  checks.push(
    item(
      "play-exe",
      has(sandboxPath, PLAY_EXE),
      "bad",
      "PlayGTAV",
      has(sandboxPath, PLAY_EXE) ? `${PLAY_EXE} is present.` : `${PLAY_EXE} is missing from the LSPDFR folder.`
    )
  );

  checks.push(
    item(
      "rph-exe",
      has(sandboxPath, RPH_EXE) || has(sandboxPath, "RAGEPluginHook.exe"),
      "bad",
      "Rage Plugin Hook",
      has(sandboxPath, RPH_EXE) || has(sandboxPath, "RAGEPluginHook.exe")
        ? "RagePluginHook.exe is in the duty folder."
        : "RagePluginHook.exe is missing."
    )
  );

  const pluginDll = has(sandboxPath, "plugins", "LSPD First Response.dll");
  const rootPlugin = has(sandboxPath, "LSPD First Response.dll");
  checks.push(
    item(
      "lspdfr-plugin",
      pluginDll && !rootPlugin,
      "bad",
      "LSPDFR plugin location",
      !pluginDll
        ? "LSPD First Response.dll must live in Plugins\\."
        : rootPlugin
          ? "A second LSPD First Response.dll is in the game root. That dual-load breaks the plugin."
          : "LSPD First Response.dll is only in Plugins\\."
    )
  );

  const missingRoot = REQUIRED_ROOT_DLLS.filter((name) => !has(sandboxPath, name));
  checks.push(
    item(
      "root-deps",
      missingRoot.length === 0,
      "bad",
      "LSPDFR support DLLs",
      missingRoot.length
        ? `Missing next to the game exe: ${missingRoot.join(", ")}. These must not sit only in Plugins\\LSPDFR.`
        : "LMS.Common, DiscordRpcNet, DdsConvert, SlimDX, and EasyHook are next to the game exe."
    )
  );

  const junk = pluginRootJunk(sandboxPath);
  checks.push(
    item(
      "plugins-clean",
      junk.length === 0,
      "bad",
      "Plugins folder",
      junk.length
        ? `Extra files in Plugins\\ will be treated as plugins: ${junk.join(", ")}.`
        : "Plugins\\ only has LSPD First Response and the LSPDFR subfolder."
    )
  );

  const newtonsoft = findNewtonsoft(sandboxPath);
  checks.push(
    item(
      "no-newtonsoft",
      newtonsoft.length === 0,
      "bad",
      "Newtonsoft.Json",
      newtonsoft.length
        ? `Remove ${newtonsoft.join(", ")}. LSPDFR already embeds JSON.NET; a loose copy breaks load.`
        : "No extra Newtonsoft.Json.dll is present."
    )
  );

  const startup = readText(fileIn(sandboxPath, "startup.rphs")).trim();
  const startupOk = /^LoadPlugin\s+"LSPD First Response\.dll"$/i.test(startup);
  checks.push(
    item(
      "startup-rphs",
      startupOk,
      "bad",
      "Auto-load script",
      startupOk
        ? "startup.rphs loads only LSPD First Response.dll."
        : `startup.rphs must be LoadPlugin "LSPD First Response.dll" (not ReloadAllPlugins). Now: ${startup || "(empty)"}`
    )
  );

  const ini = readText(fileIn(sandboxPath, "RagePluginHook.ini"));
  const timeout = (ini.match(/^\s*PluginTimeoutThreshold\s*=\s*(\d+)/im) || [])[1];
  checks.push(
    item(
      "plugin-timeout",
      timeout === "60000",
      "warn",
      "Plugin timeout",
      timeout === "60000"
        ? "PluginTimeoutThreshold is 60000."
        : `PluginTimeoutThreshold is ${timeout || "missing"}. RPH only accepts 60000.`
    )
  );

  const xinput = fileIn(sandboxPath, "XInput1_4.dll");
  let xinputOk = exists(xinput);
  let xinputDetail = "XInput1_4.dll (ASI loader) is present.";
  if (exists(xinput)) {
    try {
      const size = fs.statSync(xinput).size;
      if (size < 100000) {
        xinputOk = false;
        xinputDetail = "XInput1_4.dll is the small RPH hook, not the ASI loader. DirectStorageFix will not run.";
      }
    } catch {
      xinputOk = false;
      xinputDetail = "Could not read XInput1_4.dll.";
    }
  } else {
    xinputOk = has(sandboxPath, "dinput8.dll");
    xinputDetail = xinputOk
      ? "dinput8.dll is present as the ASI loader."
      : "No ASI loader (XInput1_4.dll or dinput8.dll).";
  }
  checks.push(
    item(
      "asi-loader",
      xinputOk && (has(sandboxPath, "dinput8.dll") || exists(xinput)),
      "warn",
      "ASI loader",
      xinputDetail
    )
  );

  checks.push(
    item(
      "directstorage",
      has(sandboxPath, "DirectStorageFix.asi"),
      "warn",
      "DirectStorageFix",
      has(sandboxPath, "DirectStorageFix.asi")
        ? "DirectStorageFix.asi is installed."
        : "DirectStorageFix.asi is missing. Enhanced often needs it for RPH."
    )
  );

  const commandline = readText(fileIn(sandboxPath, "commandline.txt"));
  checks.push(
    item(
      "nobattleye",
      /(?:^|\s)-nobattleye\b/i.test(commandline),
      "bad",
      "BattlEye off (Story Mode)",
      /(?:^|\s)-nobattleye\b/i.test(commandline)
        ? "commandline.txt has -nobattleye."
        : "commandline.txt is missing -nobattleye. Story Mode mods will crash."
    )
  );

  const appId = readText(fileIn(sandboxPath, "steam_appid.txt")).trim();
  checks.push(
    item(
      "steam-appid",
      appId === "3240220",
      "warn",
      "Steam app id",
      appId === "3240220" ? "steam_appid.txt is 3240220 (Enhanced)." : `steam_appid.txt is ${appId || "missing"}. It must be 3240220.`
    )
  );

  if (officialPath && isEnhancedFolder(officialPath)) {
    const leaked = OFFICIAL_FORBIDDEN.filter((rel) => has(officialPath, rel));
    const same =
      path.resolve(sandboxPath || "").toLowerCase() === path.resolve(officialPath || "").toLowerCase();
    checks.push(
      item(
        "online-clean",
        !same && leaked.length === 0,
        "bad",
        "Online folder",
        same
          ? "Duty and Online folders are the same path. Mods must never go in the Steam folder."
          : leaked.length
            ? `Mod files are in the official Steam folder: ${leaked.join(", ")}.`
            : "Official Enhanced folder has no LSPDFR / RPH files."
      )
    );
  }

  const mapping = verifyMapping();
  checks.push(
    item(
      "install-mapping",
      mapping.ok,
      "bad",
      "Install mapping",
      mapping.ok
        ? "LSPDFR support DLLs still map to the game root; the plugin maps to Plugins\\."
        : `Installer mapping leaked support DLLs into Plugins: ${mapping.leaked.join(", ") || mapping.pluginDest}.`
    )
  );

  const logText = readText(fileIn(sandboxPath, "RagePluginHook.log"));
  if (logText) {
    const failed = /Failed to load plugin/i.test(logText) && /LSPD First Response/i.test(logText);
    const loaded = /Loading plugin from path:.*LSPD First Response\.dll/i.test(logText) && !failed;
    checks.push(
      item(
        "last-rph-log",
        !failed,
        "warn",
        "Last Rage Plugin Hook log",
        failed
          ? "The current RagePluginHook.log still shows LSPDFR failed to load. Play LSPDFR again after fixing files."
          : loaded
            ? "The current log reached LSPDFR plugin load without a Failed to load plugin error."
            : "RagePluginHook.log is present. Launch once after file changes to confirm a clean load."
      )
    );
  }

  const failed = checks.filter((row) => !row.ok);
  const blocking = failed.filter((row) => row.level === "bad").length;
  const warnings = failed.filter((row) => row.level === "warn").length;
  return {
    ok: blocking === 0,
    verdict: blocking ? "blocked" : warnings ? "caution" : "ready",
    summary: blocking
      ? `${blocking} launch-integrity issue(s) would stop GTA or LSPDFR.`
      : warnings
        ? `${warnings} warning(s) on the working launch layout.`
        : "GTA Enhanced + LSPDFR launch layout matches the known-good setup.",
    blocking,
    warnings,
    passed: checks.filter((row) => row.ok).length,
    total: checks.length,
    checks,
    requiredRootDlls: REQUIRED_ROOT_DLLS,
    rphRootDlls: [...RPH_ROOT_DLLS],
  };
}

module.exports = {
  REQUIRED_ROOT_DLLS,
  PLUGIN_ROOT_OK,
  verifyLaunchIntegrity,
  verifyMapping,
};
