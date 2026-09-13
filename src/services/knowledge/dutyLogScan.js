const fs = require("fs");
const path = require("path");

// Discover Duty-side log files for runtime checks. Never leaves the Duty
// folder. Never opens the official Online install.

const MAX_FILES = 80;
const MAX_DEPTH = 5;
const WINDOW_BYTES = 2 * 1024 * 1024;
const ROTATED_MAX_AGE_MS = 36 * 60 * 60 * 1000;

const SKIP_DIR = /^(battleye|update|x64|mods|redistributables|nv_cache|cache|easyanticheat|documentation|licenses?|eula|privacy)$/i;
const SKIP_FILE = /^(args|commandline|steam_appid|playgtav|gta5_enhanced)\.txt$/i;
const SKIP_REL = /(?:^|\/)(?:documentation|licenses?|eula|privacy|errorcodes|battleye)\//i;
const LOG_FILE = /\.log$/i;
const ROOT_TXT = /^(asiload|asilog|els)\.txt$/i;

const ALWAYS = [
  "RagePluginHook.log",
  path.join("plugins", "LSPDFR", "RagePluginHook.log"),
  path.join("plugins", "LSPDFR", "LSPDFR.log"),
  "asiload.log",
  "asilog.txt",
  "ScriptHookV.log",
];

let cache = { duty: "", at: 0, files: [] };

function insideDuty(dutyPath, abs) {
  const root = path.resolve(dutyPath);
  const target = path.resolve(abs);
  const prefix = root.toLowerCase().endsWith(path.sep) ? root.toLowerCase() : `${root.toLowerCase()}${path.sep}`;
  return target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(prefix);
}

function addUnique(out, abs) {
  const key = String(abs || "").toLowerCase();
  if (!key || out.some((row) => row.toLowerCase() === key)) return;
  out.push(abs);
}

function walk(dutyPath, dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (!entry.name || entry.name === "." || entry.name === "..") continue;
    const abs = path.join(dir, entry.name);
    if (!insideDuty(dutyPath, abs)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIR.test(entry.name)) continue;
      walk(dutyPath, abs, depth + 1, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(dutyPath, abs).replace(/\\/g, "/");
    if (SKIP_REL.test(rel) || SKIP_FILE.test(entry.name)) continue;
    const rootTxt = depth === 0 && ROOT_TXT.test(entry.name);
    if (!LOG_FILE.test(entry.name) && !rootTxt) continue;
    addUnique(out, abs);
  }
}

function isRotatedArchive(abs, dutyPath) {
  const rel = path.relative(dutyPath, abs).replace(/\\/g, "/");
  return /^logs\//i.test(rel) || /^RagePluginHook_\d/i.test(path.basename(abs));
}

function freshEnough(abs, dutyPath, session) {
  if (!isRotatedArchive(abs, dutyPath)) return true;
  try {
    const stat = fs.statSync(abs);
    if (session && session.startedAt) {
      const start = Date.parse(session.startedAt);
      if (Number.isFinite(start) && stat.mtimeMs + 60 * 1000 >= start) return true;
      return false;
    }
    return Date.now() - stat.mtimeMs <= ROTATED_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function discoverDutyLogs(dutyPath, { session = null } = {}) {
  const duty = String(dutyPath || "").trim();
  if (!duty) return [];
  const now = Date.now();
  const cacheKey = `${path.resolve(duty)}|${session && session.sessionId ? session.sessionId : "live"}`;
  if (cache.duty === cacheKey && now - cache.at < 2500) return cache.files;

  const found = [];
  for (const rel of ALWAYS) {
    const abs = path.join(duty, rel);
    if (insideDuty(duty, abs) && fs.existsSync(abs)) addUnique(found, abs);
  }
  walk(duty, duty, 0, found);
  const files = found.filter((abs) => insideDuty(duty, abs) && freshEnough(abs, duty, session));
  cache = { duty: cacheKey, at: now, files };
  return files;
}

function readBoundedWindow(filePath, maxBytes = WINDOW_BYTES) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "";
    const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function collectLogFiles(session, dutyPath) {
  const paths = [];
  for (const log of (session && session.logs) || []) {
    if (log && log.path && (!dutyPath || insideDuty(dutyPath, log.path) || /sessions/i.test(String(log.path)))) {
      addUnique(paths, log.path);
    }
  }
  for (const abs of discoverDutyLogs(dutyPath, { session })) addUnique(paths, abs);
  return paths
    .filter((abs) => !dutyPath || insideDuty(dutyPath, abs) || /[/\\]sessions[/\\]/i.test(abs))
    .map((abs) => {
      const text = readBoundedWindow(abs);
      return text ? { path: abs, name: path.basename(abs), text } : null;
    })
    .filter(Boolean);
}

function joinLogFiles(files) {
  return (files || [])
    .map((file) => `[LOGFILE ${file.name}]\n${file.text}`)
    .filter(Boolean)
    .join("\n");
}

function clearCache() {
  cache = { duty: "", at: 0, files: [] };
}

module.exports = {
  MAX_FILES,
  insideDuty,
  discoverDutyLogs,
  readBoundedWindow,
  collectLogFiles,
  joinLogFiles,
  clearCache,
};
