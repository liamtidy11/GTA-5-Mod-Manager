const fs = require("fs");
const path = require("path");
const os = require("os");

const BACKUP_SUFFIX = ".tactix-mdt-backup";

const DEFAULT_SETTINGS = path.join(
  os.homedir(),
  "OneDrive",
  "Documents",
  "Rockstar Games",
  "GTAV Enhanced",
  "settings.xml"
);

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function backupPath(settingsFile) {
  return `${settingsFile}${BACKUP_SUFFIX}`;
}

function readSettings(settingsFile) {
  const file = String(settingsFile || DEFAULT_SETTINGS);
  try {
    return { file, text: fs.readFileSync(file, "utf8"), missing: false };
  } catch {
    return { file, text: "", missing: true };
  }
}

function attr(text, name) {
  const hit = String(text || "").match(new RegExp(`<${name}\\s+value="([^"]*)"`, "i"));
  return hit ? hit[1] : "";
}

function setAttr(text, name, value) {
  const next = String(value);
  const re = new RegExp(`(<${name}\\s+value=")([^"]*)(")`, "i");
  if (!re.test(text)) return { text, changed: false };
  return { text: String(text).replace(re, `$1${next}$3`), changed: true };
}

function frameGenState(text) {
  const fsr3 = attr(text, "fsr3FrameGenMode");
  const type = attr(text, "FrameGenType");
  return {
    fsr3FrameGenMode: fsr3,
    frameGenType: type,
    enabled: fsr3 === "1" || type === "1",
  };
}

function disableFrameGen(text) {
  let next = String(text || "");
  const a = setAttr(next, "fsr3FrameGenMode", "0");
  next = a.text;
  const b = setAttr(next, "FrameGenType", "0");
  next = b.text;
  return { text: next, changed: a.changed || b.changed };
}

function backupAndDisableFrameGen(settingsFile = DEFAULT_SETTINGS) {
  const current = readSettings(settingsFile);
  if (current.missing) return { ok: false, reason: "MISSING", file: current.file };
  const before = frameGenState(current.text);
  const backup = backupPath(current.file);
  if (!exists(backup)) fs.copyFileSync(current.file, backup);
  const edited = disableFrameGen(current.text);
  if (edited.changed) fs.writeFileSync(current.file, edited.text, "utf8");
  return {
    ok: true,
    file: current.file,
    backup,
    before,
    after: frameGenState(edited.text),
    changed: edited.changed,
  };
}

function restoreFrameGenBackup(settingsFile = DEFAULT_SETTINGS) {
  const file = String(settingsFile || DEFAULT_SETTINGS);
  const backup = backupPath(file);
  if (!exists(backup)) return { ok: false, reason: "NO_BACKUP", file, backup };
  fs.copyFileSync(backup, file);
  return { ok: true, file, backup, after: frameGenState(fs.readFileSync(file, "utf8")) };
}

module.exports = {
  BACKUP_SUFFIX,
  DEFAULT_SETTINGS,
  backupPath,
  readSettings,
  frameGenState,
  disableFrameGen,
  backupAndDisableFrameGen,
  restoreFrameGenBackup,
};
