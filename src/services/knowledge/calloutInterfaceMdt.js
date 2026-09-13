const fs = require("fs");
const path = require("path");
const mdtRenderStack = require("./mdtRenderStack");
const overlays = require("../overlays");
const mdtVerified = require("./mdtVerified");
const gtaEnhancedGraphics = require("./gtaEnhancedGraphics");

const CONFIG_REL = path.join("plugins", "LSPDFR", "CalloutInterface.ini");
const CI_DLL = "calloutinterface.dll";

const TRUTHY = /^(true|1|yes|on)$/i;
const FALSY = /^(false|0|no|off)$/i;
const KEY_NAME = /key|hotkey|bind|shortcut/i;

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function parseIni(text) {
  const sections = {};
  let section = "";
  let pairs = 0;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("//")) continue;
    const sec = line.match(/^\[(.+)]$/);
    if (sec) {
      section = sec[1].trim();
      if (!sections[section]) sections[section] = {};
      continue;
    }
    const pair = line.match(/^([^=]+)=(.*)$/);
    if (!pair) continue;
    const name = pair[1].trim();
    const value = pair[2].trim();
    if (!sections[section]) sections[section] = {};
    sections[section][name] = value;
    pairs += 1;
  }
  return { sections, pairs };
}

function getValue(parsed, names) {
  const want = (names || []).map((name) => String(name).toLowerCase());
  for (const section of Object.values(parsed.sections || {})) {
    for (const [key, value] of Object.entries(section)) {
      if (want.includes(String(key).toLowerCase())) return { name: key, value: String(value) };
    }
  }
  return { name: "", value: "" };
}

function parseBool(value) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, value: null };
  if (TRUTHY.test(text)) return { ok: true, value: true };
  if (FALSY.test(text)) return { ok: true, value: false };
  return { ok: false, value: null };
}

function parseIntValue(value) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, value: null };
  const n = Number.parseInt(text, 10);
  if (!Number.isFinite(n)) return { ok: false, value: null };
  return { ok: true, value: n };
}

function displayKey(value) {
  const raw = String(value || "").trim();
  if (!raw || /^none$/i.test(raw)) return "NONE";
  const num = raw.match(/^numpad(\d)$/i);
  if (num) return `NUMPAD${num[1]}`;
  return raw.replace(/\s+/g, "").toUpperCase();
}

function sameKey(a, b) {
  const left = displayKey(a);
  const right = displayKey(b);
  return Boolean(left && right && left !== "NONE" && left === right);
}

function looksLikeKeyValue(name, value) {
  const val = String(value || "").trim();
  if (!val || /^none$/i.test(val) || val.length > 48) return false;
  if (KEY_NAME.test(name)) return true;
  return /^(?:f(?:1[0-9]|2[0-4]|[1-9])|[a-z]|d[0-9]|numpad[0-9]|l(?:control|menu|shift)key|r(?:control|menu|shift)key)$/i.test(val);
}

function walkIniFiles(root, acc = []) {
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of names) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkIniFiles(full, acc);
      continue;
    }
    if (entry.isFile() && /\.ini$/i.test(entry.name)) acc.push(full);
  }
  return acc;
}

function collectPeerBinds(dutyPath, selfFile) {
  const plugins = path.join(dutyPath || "", "plugins");
  const self = path.normalize(selfFile || "");
  const out = [];
  for (const file of walkIniFiles(plugins)) {
    if (path.normalize(file) === self) continue;
    const parsed = parseIni(readText(file));
    for (const [section, rows] of Object.entries(parsed.sections || {})) {
      for (const [name, value] of Object.entries(rows)) {
        if (!looksLikeKeyValue(name, value)) continue;
        out.push({
          file: path.relative(dutyPath, file).replace(/\\/g, "/"),
          section,
          name,
          value: String(value).trim(),
        });
      }
    }
  }
  return out;
}

function parseConfig(text) {
  const raw = String(text || "");
  if (!raw.trim()) {
    return {
      present: false,
      malformed: false,
      toggleKey: "",
      toggleModifier: "None",
      holdInterval: null,
      menuKey: "",
      mdtEnabled: null,
      mdtToggledOn: null,
      mdtOnlyInVehicle: null,
      values: {},
    };
  }
  const parsed = parseIni(raw);
  const toggle = getValue(parsed, ["ToggleTerminalKey", "TerminalKey", "MDTKey", "ToggleMDTKey"]);
  const menu = getValue(parsed, ["CalloutMenuKey"]);
  const hold = parseIntValue(getValue(parsed, ["HoldInterval"]).value);
  const enabled = parseBool(getValue(parsed, ["MDTEnabled"]).value);
  const toggled = parseBool(getValue(parsed, ["MDTToggledOn"]).value);
  const vehicle = parseBool(getValue(parsed, ["MDTOnlyInVehicle"]).value);
  const enabledRaw = getValue(parsed, ["MDTEnabled"]).value;
  const malformed =
    parsed.pairs === 0 ||
    (enabledRaw && !enabled.ok) ||
    (toggle.value && !toggle.value.trim());
  return {
    present: true,
    malformed: Boolean(malformed),
    toggleKey: toggle.value || "",
    toggleModifier: "None",
    holdInterval: hold.ok ? hold.value : null,
    menuKey: menu.value || "",
    mdtEnabled: enabled.ok ? enabled.value : null,
    mdtToggledOn: toggled.ok ? toggled.value : null,
    mdtOnlyInVehicle: vehicle.ok ? vehicle.value : null,
    values: {
      ToggleTerminalKey: toggle.value || "",
      CalloutMenuKey: menu.value || "",
      HoldInterval: hold.ok ? String(hold.value) : "",
      MDTEnabled: enabledRaw,
      MDTToggledOn: getValue(parsed, ["MDTToggledOn"]).value,
      MDTOnlyInVehicle: getValue(parsed, ["MDTOnlyInVehicle"]).value,
    },
  };
}

function classifyLog(text) {
  const blob = String(text || "");
  const pluginInit = /Creating plugin:\s*CalloutInterface\b/i.test(blob) || /CalloutInterface\.dll:\s*CalloutInterface/i.test(blob);
  const depMissing = /CalloutInterface(?:\.dll)?\s+dependency\s+\S+\s+is not available/i.test(blob);
  const depOk = /CalloutInterface(?:\.dll)?\s+dependency\s+IPT\.Common\.dll\s+is available/i.test(blob);
  const mdtInitFail =
    /CalloutInterface.{0,80}(?:failed to initialize|initialization failed).{0,40}(?:MDT|terminal)/i.test(blob) ||
    /(?:MDT|terminal).{0,40}(?:failed to initialize|initialization failed)/i.test(blob);
  const interactive = /RawCanvasUI.{0,40}isInteractive to True/i.test(blob);
  const canvas = /RawCanvasUI.{0,80}canvas updated bounds/i.test(blob);
  const overlayFail = /D3D12 command queue does not belong to the D3D12 device/i.test(blob);
  const exception = /CalloutInterface.{0,120}(?:unhandled exception|threw an exception|fatal error)/i.test(blob);
  return {
    pluginInit,
    depMissing,
    depOk,
    mdtInitFail,
    interactive,
    canvas,
    overlayFail,
    exception,
  };
}

function pluginStatus(log) {
  if (log.exception || log.depMissing) return "FAILED";
  if (log.pluginInit) return "WORKING";
  return "UNVERIFIED";
}

function yesNoUnknown(value) {
  if (value === true) return "YES";
  if (value === false) return "NO";
  return "UNKNOWN";
}

function enabledLabel(value) {
  if (value === true) return "ENABLED";
  if (value === false) return "DISABLED";
  return "UNKNOWN";
}

function firstMatch(text, pattern) {
  const hit = String(text || "").match(pattern);
  return hit ? hit[0].replace(/^\[[^\]]+\]\s*/, "").trim().slice(0, 240) : "";
}

function isCalloutInterface(mod = {}) {
  const id = String(mod.canonicalModId || mod.id || "").toLowerCase();
  if (id === "callout-interface" || id.endsWith(":calloutinterface.dll")) return true;
  if (/callout\s*interface/i.test(mod.name || "")) return true;
  return (mod.files || []).some((file) => {
    const dest = String(typeof file === "string" ? file : (file && (file.destination || file.dest)) || "")
      .replace(/\\/g, "/")
      .toLowerCase();
    return dest.endsWith(CI_DLL);
  });
}

function diagnose({
  dutyPath = "",
  logText = "",
  configText = null,
  peerBinds = null,
  mod = {},
  overlayStatus = null,
  readVersion = null,
  dataDir = "",
  verifiedNote = null,
  frameGen = null,
} = {}) {
  const configPath = path.join(dutyPath || "", CONFIG_REL);
  const rawConfig = configText == null ? readText(configPath) : String(configText);
  const config = parseConfig(rawConfig);
  const log = classifyLog(logText);
  const plugin = pluginStatus(log);
  const peers = peerBinds || (dutyPath ? collectPeerBinds(dutyPath, configPath) : []);
  const conflicts = config.toggleKey
    ? peers.filter((row) => sameKey(row.value, config.toggleKey))
    : [];

  let cause = "NONE";
  let mdtError = "NONE";
  let evidence = "";

  if (!config.present) {
    cause = "MISSING_CONFIG";
    mdtError = "CalloutInterface.ini was not found.";
  } else if (config.malformed) {
    cause = "MALFORMED";
    mdtError = "CalloutInterface.ini could not be parsed.";
  } else if (config.mdtEnabled === false) {
    cause = "DISABLED";
    mdtError = "MDTEnabled is False.";
  } else if (log.mdtInitFail) {
    cause = "INIT_FAIL";
    mdtError = firstMatch(logText, /(?:CalloutInterface.{0,80})?(?:MDT|terminal).{0,40}(?:failed to initialize|initialization failed).*/i) ||
      "MDT initialization failed.";
    evidence = mdtError;
  } else if (log.depMissing || log.exception) {
    cause = "DEPENDENCY";
    mdtError = firstMatch(logText, /CalloutInterface.{0,160}/i) || "Callout Interface dependency or exception failed.";
    evidence = mdtError;
  } else if (log.pluginInit && log.interactive && log.overlayFail) {
    cause = "RENDER";
    mdtError = "Rage Plugin Hook D3D12 overlay did not draw the RawCanvasUI terminal.";
    evidence = firstMatch(logText, /RawCanvasUI.{0,40}isInteractive to True.*/i);
  } else if (log.pluginInit && log.overlayFail && !log.interactive) {
    cause = "RENDER";
    mdtError = "Rage Plugin Hook D3D12 overlay failed; no MDT toggle was logged.";
    evidence = firstMatch(logText, /D3D12 command queue does not belong.*/i);
  } else if (log.pluginInit && !log.interactive) {
    cause = "NO_PROOF";
    mdtError = "NONE";
    evidence = firstMatch(logText, /Creating plugin:\s*CalloutInterface.*/i);
  } else if (log.pluginInit && log.interactive) {
    cause = "NONE";
    evidence = firstMatch(logText, /RawCanvasUI.{0,40}isInteractive to True.*/i);
  } else {
    cause = "NO_PROOF";
  }

  if (config.mdtOnlyInVehicle === true && (cause === "NO_PROOF" || cause === "NONE")) {
    cause = "VEHICLE_ONLY";
  }

  const render = mdtRenderStack.classifyRender(logText);
  const graphics = mdtRenderStack.parseGraphics(logText);
  const inventory = dutyPath ? mdtRenderStack.inventoryUiLibraries(dutyPath, { readVersion }) : { rawCanvas: null, libraries: [] };
  const overlay = mdtRenderStack.overlaySnapshot(overlayStatus || overlays.overlayStatus());
  const hookFiles = dutyPath ? mdtRenderStack.hookFilesPresent(dutyPath) : [];
  const verified = verifiedNote != null ? verifiedNote : mdtVerified.load(dataDir);
  const fg = frameGen != null ? frameGen : gtaEnhancedGraphics.frameGenState(gtaEnhancedGraphics.readSettings().text);
  const suggestion = mdtRenderStack.suggestedFix({
    render,
    overlays: overlay,
    inventory,
    hookFiles,
    verified,
    frameGen: fg,
  });
  const report = {
    plugin,
    mdt: enabledLabel(config.mdtEnabled),
    toggleKey: config.toggleKey ? displayKey(config.toggleKey) : "UNKNOWN",
    toggleModifier: displayKey(config.toggleModifier),
    holdInterval: config.holdInterval,
    menuKey: config.menuKey ? displayKey(config.menuKey) : "UNKNOWN",
    vehicleOnly: yesNoUnknown(config.mdtOnlyInVehicle),
    toggledOn: yesNoUnknown(config.mdtToggledOn),
    lastRuntimeEvidence: evidence || "NONE",
    keyConflict: conflicts.length
      ? conflicts.map((row) => `${row.file} ${row.name}=${row.value}`).join("; ")
      : "NONE",
    mdtError,
    cause,
    config,
    log,
    conflicts,
    pressHint: pressHint(config),
    renderer: inventory.rawCanvas && inventory.rawCanvas.version
      ? `RawCanvasUI ${inventory.rawCanvas.version}`
      : "RawCanvasUI",
    graphicsApi: graphics.api,
    mdtInput: render.input,
    mdtCanvas: render.canvas,
    mdtRendering: render.rendering,
    renderStatus: render.status,
    lastRenderError: render.lastError || "NONE",
    suggestedFix: suggestion,
    inventory,
    overlay,
    graphics,
    hookFiles,
    verified,
    frameGen: fg,
  };
  applyVerifiedWorking(report);
  report.summary = formatSummary(report);
  return report;
}

function applyVerifiedWorking(report) {
  const verified = report.verified;
  const fg = report.frameGen;
  if (!verified || !verified.verified || !fg || fg.enabled) return;
  if (report.plugin !== "WORKING") return;
  if (report.mdtInput !== "DETECTED" && report.mdtCanvas !== "INITIALIZED") return;
  report.mdtRendering = "WORKING";
  report.renderStatus = mdtRenderStack.RENDER.RENDER_CONFIRMED;
  report.lastRenderError = "NONE";
  report.cause = "NONE";
  report.mdtError = "NONE";
  report.suggestedFix = "NONE. Keep FSR3 frame generation off so the MDT stays visible.";
}

function pressHint(config) {
  if (!config.toggleKey) return "No MDT toggle key is configured.";
  const hold = config.holdInterval != null ? ` Hold for at least ${config.holdInterval} ms to show the cursor.` : " Hold the key to interact.";
  const vehicle = config.mdtOnlyInVehicle ? " Only while in a vehicle." : " Works on foot.";
  const numLock = /^numpad\d$/i.test(config.toggleKey) ? " Num Lock must be on." : "";
  return `Press ${displayKey(config.toggleKey)} (no modifier).${hold}${vehicle}${numLock}`;
}

function formatSummary(report) {
  return [
    "CALLOUT INTERFACE",
    `Callout Interface: ${report.plugin}`,
    `MDT configuration: ${report.mdt}`,
    `MDT input: ${report.mdtInput || "UNVERIFIED"}`,
    `MDT canvas: ${report.mdtCanvas || "UNVERIFIED"}`,
    `MDT rendering: ${report.mdtRendering || "UNVERIFIED"}`,
    `Renderer: ${report.renderer || "RawCanvasUI"}`,
    `Graphics API: ${report.graphicsApi || "UNKNOWN"}`,
    `Last render error: ${report.lastRenderError || "NONE"}`,
    `Suggested fix: ${report.suggestedFix || "NONE"}`,
    `Toggle key: ${report.toggleKey}`,
    `Vehicle only: ${report.vehicleOnly}`,
    `Key conflict: ${report.keyConflict}`,
  ].join("\n");
}

module.exports = {
  CONFIG_REL,
  parseIni,
  parseConfig,
  classifyLog,
  diagnose,
  displayKey,
  sameKey,
  isCalloutInterface,
  collectPeerBinds,
  formatSummary,
};
