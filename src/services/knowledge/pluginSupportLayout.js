const fs = require("fs");
const path = require("path");
const { exists, isEnhancedFolder } = require("../paths");
const { RPH_ROOT_DLLS } = require("../modtypes");

const NEVER_MIRROR_TO_ROOT = new Set([
  "xinput1_4.dll",
  "newtonsoft.json.dll",
  "lspd first response.dll",
]);

const KEEP_IN_PLUGIN_TREE = new Set([
  "lspd first response.dll",
  "lspd first response.dll.config",
  "lspd first response.pdb",
]);

// Official CI/GP install: these sit next to the game exe. IPT.Common in
// plugins\LSPDFR is scanned as a plugin and fails ("Cannot create an abstract class").
const ROOT_PLUGIN_LIBRARIES = ["IPT.Common.dll", "RawCanvasUI.dll", "CalloutInterfaceAPI.dll"];
const NOT_A_PLUGIN_LIBRARY = new Set(["ipt.common.dll", "rawcanvasui.dll"]);

function baseName(rel) {
  return String(rel || "")
    .replace(/[/\\]+/g, "/")
    .split("/")
    .pop();
}

function isStraySupportName(name) {
  const lower = String(name || "").toLowerCase();
  if (!lower || KEEP_IN_PLUGIN_TREE.has(lower)) return false;
  if (!lower.endsWith(".dll") && !lower.endsWith(".dll.config")) return false;
  if (RPH_ROOT_DLLS.has(lower) || NOT_A_PLUGIN_LIBRARY.has(lower)) return true;
  return /^(ddsconvert|discord|lms\.|easyhook|gwen|slimdx|mono\.|fw1|system\.valuetuple|microsoft\.)/i.test(lower);
}

function destPresentOnDuty(dutyPath, rel) {
  if (!dutyPath) return false;
  const norm = String(rel || "")
    .replace(/[/\\]+/g, path.sep)
    .replace(/^[/\\]+/, "");
  if (!norm || norm.split(path.sep).includes("..")) return false;
  if (exists(path.join(dutyPath, norm))) return true;
  const file = path.basename(norm);
  if (isStraySupportName(file) && exists(path.join(dutyPath, file))) return true;
  return ROOT_PLUGIN_LIBRARIES.some((name) => name.toLowerCase() === file.toLowerCase()) && exists(path.join(dutyPath, file));
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function findStraySupportDlls(dutyPath) {
  const duty = String(dutyPath || "").trim();
  if (!duty) return [];
  const found = [];
  const dirs = [path.join(duty, "plugins", "LSPDFR"), path.join(duty, "plugins")];
  for (const dir of dirs) {
    const pluginRoot = path.basename(dir).toLowerCase() === "plugins";
    for (const name of listNames(dir)) {
      if (pluginRoot && name.toLowerCase() === "lspdfr") continue;
      if (!isStraySupportName(name)) continue;
      found.push({
        dir,
        name,
        rel: path.relative(duty, path.join(dir, name)).replace(/\\/g, "/"),
      });
    }
  }
  return found;
}

function clearStraySupportDlls(dutyPath) {
  const removed = [];
  const copied = [];
  const skipped = [];
  if (!dutyPath || !isEnhancedFolder(dutyPath)) {
    return { removed, copied, skipped, changed: false };
  }
  for (const item of findStraySupportDlls(dutyPath)) {
    const src = path.join(item.dir, item.name);
    const dest = path.join(dutyPath, item.name);
    const lower = item.name.toLowerCase();
    try {
      if (!NEVER_MIRROR_TO_ROOT.has(lower) && !exists(dest)) {
        fs.copyFileSync(src, dest);
        copied.push(item.rel);
      }
      if (NEVER_MIRROR_TO_ROOT.has(lower) || exists(dest)) {
        fs.rmSync(src, { force: true });
        removed.push(item.rel);
      } else {
        skipped.push(item.rel);
      }
    } catch {
      skipped.push(item.rel);
    }
  }
  return {
    removed,
    copied,
    skipped,
    changed: Boolean(removed.length || copied.length),
  };
}

function findMissingPluginLibraries(dutyPath) {
  const duty = String(dutyPath || "").trim();
  if (!duty) return [];
  const pluginDir = path.join(duty, "plugins", "LSPDFR");
  const missing = [];
  for (const name of ROOT_PLUGIN_LIBRARIES) {
    const root = path.join(duty, name);
    const plugin = path.join(pluginDir, name);
    if (exists(root)) continue;
    if (!exists(plugin) && name.toLowerCase() !== "calloutinterfaceapi.dll") continue;
    if (!exists(plugin) && !exists(root)) continue;
    missing.push({
      name,
      from: exists(plugin) ? path.posix.join("plugins", "LSPDFR", name) : name,
      to: name,
    });
  }
  for (const name of ROOT_PLUGIN_LIBRARIES) {
    if (!NOT_A_PLUGIN_LIBRARY.has(name.toLowerCase())) continue;
    const plugin = path.join(pluginDir, name);
    if (!exists(plugin)) continue;
    if (missing.some((row) => row.name.toLowerCase() === name.toLowerCase())) continue;
    missing.push({
      name,
      from: path.posix.join("plugins", "LSPDFR", name),
      to: name,
    });
  }
  return missing;
}

function ensureLspdfrProbing(dutyPath) {
  const file = path.join(dutyPath, "plugins", "LSPD First Response.dll.config");
  if (!exists(file)) return false;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (/privatePath\s*=\s*"[^"]*\.\./i.test(text)) return false;
  const next = text.replace(/privatePath\s*=\s*"LSPDFR"/i, 'privatePath="LSPDFR;.."');
  if (next === text) return false;
  try {
    fs.writeFileSync(file, next, "utf8");
    return true;
  } catch {
    return false;
  }
}

function ensureRootPluginLibraries(dutyPath) {
  const copied = [];
  const removed = [];
  const skipped = [];
  if (!dutyPath || !isEnhancedFolder(dutyPath)) {
    return { copied, removed, skipped, changed: false };
  }
  const pluginDir = path.join(dutyPath, "plugins", "LSPDFR");
  for (const name of ROOT_PLUGIN_LIBRARIES) {
    const root = path.join(dutyPath, name);
    const plugin = path.join(pluginDir, name);
    try {
      if (!exists(root) && exists(plugin)) {
        fs.copyFileSync(plugin, root);
        copied.push(name);
      }
      if (NOT_A_PLUGIN_LIBRARY.has(name.toLowerCase()) && exists(plugin) && exists(root)) {
        fs.rmSync(plugin, { force: true });
        removed.push(path.posix.join("plugins", "LSPDFR", name));
      }
    } catch {
      skipped.push(name);
    }
  }
  const probed = ensureLspdfrProbing(dutyPath);
  return {
    copied,
    removed,
    skipped,
    changed: Boolean(copied.length || removed.length || probed),
  };
}

function mirrorPluginLibraries(dutyPath) {
  return ensureRootPluginLibraries(dutyPath);
}

module.exports = {
  NEVER_MIRROR_TO_ROOT,
  ROOT_PLUGIN_LIBRARIES,
  NOT_A_PLUGIN_LIBRARY,
  PLUGIN_SIDEBYSIDE_DLLS: ROOT_PLUGIN_LIBRARIES,
  isStraySupportName,
  destPresentOnDuty,
  findStraySupportDlls,
  findMissingPluginLibraries,
  clearStraySupportDlls,
  ensureLspdfrProbing,
  ensureRootPluginLibraries,
  mirrorPluginLibraries,
  baseName,
};
