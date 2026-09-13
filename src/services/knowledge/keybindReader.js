const fs = require("fs");
const path = require("path");
const { isConfigFile } = require("../configPolicy");

const CATALOG_PATH = path.join(__dirname, "..", "..", "data", "modKeybinds.json");

const BIND_NAME = /key|bind|hotkey|shortcut|toggle|keyboard|controller|modifier/i;
const KEY_VALUE =
  /^(?:none|f(?:1[0-9]|2[0-4]|[1-9])|[a-z]|d[0-9]|numpad[0-9]|l(?:control|menu|shift)key|r(?:control|menu|shift)key|controlkey|shiftkey|menukey|lcontrolkey|rcontrolkey|enter|return|space|tab|escape|back|backspace|insert|delete|home|end|pageup|pagedown|up|down|left|right|mouse(?:left|right|middle)?|leftthumb|rightthumb|dpad(?:up|down|left|right)|a|b|x|y)(?:\s*\+\s*[a-z0-9+ ]+)?$/i;
const README_LINE =
  /(?:press|hold|use|default|key(?:bind)?|hotkey|bind)\s+(?:is\s+)?((?:left\s+)?(?:ctrl|control|shift|alt|lcontrolkey|lshiftkey)(?:\s*\+\s*)?)?([a-z0-9]{1,12}|f1[0-9]|f2[0-4]|f[1-9])\b(?:\s*(?:to|for|->|:)\s+(.{3,80}))?/i;

const PRETTY = {
  lcontrolkey: "Left Ctrl",
  rcontrolkey: "Right Ctrl",
  controlkey: "Ctrl",
  lshiftkey: "Left Shift",
  rshiftkey: "Right Shift",
  shiftkey: "Shift",
  lmenukey: "Left Alt",
  rmenukey: "Right Alt",
  menukey: "Alt",
  return: "Enter",
  back: "Backspace",
  dpadleft: "D-Pad Left",
  dpadright: "D-Pad Right",
  dpadup: "D-Pad Up",
  dpaddown: "D-Pad Down",
  leftthumb: "Left Stick",
  rightthumb: "Right Stick",
};

let cachedCatalog = null;

function loadCatalog() {
  if (cachedCatalog) return cachedCatalog;
  try {
    cachedCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  } catch {
    cachedCatalog = { mods: {} };
  }
  return cachedCatalog;
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function humanize(name) {
  return String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_./]+/g, " ")
    .replace(/\b(key|keys|bind|binding|hotkey)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function prettyKeys(value) {
  return String(value || "")
    .split(/\s*\+\s*/)
    .map((part) => {
      const raw = part.trim();
      const lower = raw.toLowerCase();
      if (PRETTY[lower]) return PRETTY[lower];
      const numpad = raw.match(/^numpad(\d)$/i);
      if (numpad) return `NumPad ${numpad[1]}`;
      if (/^f\d{1,2}$/i.test(raw) || raw.length === 1) return raw.toUpperCase();
      return raw.replace(/([a-z])([A-Z])/g, "$1 $2");
    })
    .filter(Boolean)
    .join(" + ");
}

function looksLikeBind(name, value) {
  const val = String(value || "").trim();
  if (!val || val.length > 48) return false;
  if (/^none$/i.test(val)) return false;
  if (KEY_VALUE.test(val)) return true;
  return BIND_NAME.test(name) && /[a-z0-9]/i.test(val) && val.split(/\s+/).length <= 5;
}

function parseIni(text, file) {
  const out = [];
  let section = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sec = line.match(/^\[(.+)]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const pair = line.match(/^([^=]+)=(.*)$/);
    if (!pair) continue;
    const name = pair[1].trim();
    const value = pair[2].trim();
    if (!looksLikeBind(name, value)) continue;
    out.push({
      action: humanize(name) || name,
      keys: prettyKeys(value),
      detail: section,
      source: "config",
      file,
    });
  }
  return out;
}

function parseXml(text, file) {
  const out = [];
  const re = /<([A-Za-z0-9_:-]*?(?:Key|Bind|Hotkey|Shortcut)[A-Za-z0-9_:-]*)[^>]*>([^<]+)<\//gi;
  let match;
  while ((match = re.exec(text))) {
    const value = match[2].trim();
    if (!looksLikeBind(match[1], value)) continue;
    out.push({
      action: humanize(match[1]) || match[1],
      keys: prettyKeys(value),
      detail: "",
      source: "config",
      file,
    });
  }
  return out;
}

function walkJson(value, prefix, file, out) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const pathLabel = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === "object" && !Array.isArray(child)) {
      walkJson(child, pathLabel, file, out);
      continue;
    }
    const text = Array.isArray(child) ? child.join(" + ") : String(child == null ? "" : child);
    if (!looksLikeBind(key, text)) continue;
    out.push({
      action: humanize(key) || key,
      keys: prettyKeys(text),
      detail: prefix,
      source: "config",
      file,
    });
  }
}

function parseJson(text, file) {
  const out = [];
  try {
    walkJson(JSON.parse(text), "", file, out);
  } catch {
    /* ignore invalid json */
  }
  return out;
}

function parseReadme(text, file) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(README_LINE);
    if (!match) continue;
    const keys = prettyKeys(`${match[1] || ""} ${match[2] || ""}`);
    const detail = String(match[3] || "").replace(/[.]+$/, "").trim();
    if (!keys) continue;
    out.push({
      action: detail || "Keybind",
      keys,
      detail: detail ? "" : line.slice(0, 80),
      source: "readme",
      file,
    });
  }
  return out;
}

function parseText(text, file) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".ini" || ext === ".cfg") return parseIni(text, file);
  if (ext === ".xml") return parseXml(text, file);
  if (ext === ".json") return parseJson(text, file);
  return parseReadme(text, file);
}

function catalogEntry(modId) {
  return (loadCatalog().mods || {})[modId] || null;
}

function catalogBinds(modId) {
  const entry = catalogEntry(modId);
  if (!entry) return [];
  return (entry.binds || []).map((bind) => ({
    action: bind.action,
    keys: bind.keys,
    detail: bind.detail || "",
    source: "typical",
    file: entry.source || "Typical defaults",
  }));
}

function knownConfigFiles(canonicalModId, database) {
  const files = [];
  const catalog = catalogEntry(canonicalModId);
  for (const file of (catalog && catalog.configFiles) || []) {
    files.push(file);
  }
  const knowledge = ((database && database.mods) || []).find((row) => row.id === canonicalModId);
  for (const name of (knowledge && knowledge.recognition && knowledge.recognition.configNames) || []) {
    const rel = String(name || "").replace(/\\/g, "/");
    files.push(rel.includes("/") ? rel : `plugins/LSPDFR/${rel}`);
  }
  const seen = new Set();
  return files.filter((file) => {
    const key = String(file || "").replace(/\\/g, "/").toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueBinds(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${String(row.action || "").toLowerCase()}|${String(row.keys || "").toLowerCase()}`;
    if (!row.keys || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function collectFromFiles(files, dutyPath) {
  const out = [];
  for (const file of files || []) {
    const dest = file.destination || file;
    const abs = path.join(dutyPath, String(dest).split("/").join(path.sep));
    const text = readText(abs);
    if (!text) continue;
    if (isConfigFile(dest) || /\.(txt|md|nfo)$/i.test(dest)) out.push(...parseText(text, dest));
  }
  return out;
}

function readKeybinds({
  mod = {},
  manifest = {},
  dutyPath = "",
  canonicalModId = "",
  database = null,
} = {}) {
  const id = canonicalModId || mod.canonicalModId || "";
  const files = [...((manifest && manifest.files) || []), ...(mod.files || [])];
  for (const dest of knownConfigFiles(id, database)) {
    files.push({ destination: dest });
  }
  const fromFiles = dutyPath ? collectFromFiles(files, dutyPath) : [];
  const typical = catalogBinds(id);
  const configBinds = fromFiles.filter((row) => row.source === "config");
  const readmeBinds = fromFiles.filter((row) => row.source === "readme");
  const binds = uniqueBinds(configBinds.length ? [...configBinds, ...readmeBinds] : [...typical, ...readmeBinds]);
  return {
    binds,
    fromConfig: configBinds.length > 0,
    typicalUsed: !configBinds.length && typical.length > 0,
    note: configBinds.length
      ? "Read from this mod’s installed config files."
      : typical.length
        ? "Typical published defaults. Go on duty once if the Settings folder is still empty, then reopen Details."
        : "No keybinds were found in this mod’s configs or notes.",
  };
}

module.exports = {
  readKeybinds,
  parseIni,
  parseXml,
  parseJson,
  parseReadme,
  prettyKeys,
  humanize,
  looksLikeBind,
  knownConfigFiles,
};
