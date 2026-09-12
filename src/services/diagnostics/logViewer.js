const fs = require("fs");
const path = require("path");

// Bounded personal log viewer. Duty + manager files only. Never opens Online.

const MAX_BYTES = 400 * 1024;

function safeStat(abs) {
  try {
    const st = fs.statSync(abs);
    return { size: st.size, mtime: st.mtime.toISOString() };
  } catch {
    return null;
  }
}

function addIfExists(list, abs, name, kind) {
  const meta = safeStat(abs);
  if (!meta) return;
  list.push({ path: abs, name, kind, ...meta });
}

function listLogs({ dutyPath = "", dataDir = "", sessionRoot = "" } = {}) {
  const logs = [];
  if (dutyPath) {
    addIfExists(logs, path.join(dutyPath, "RagePluginHook.log"), "RagePluginHook.log", "RPH");
    const pluginDir = path.join(dutyPath, "plugins", "LSPDFR");
    try {
      for (const name of fs.readdirSync(pluginDir)) {
        if (/\.log$/i.test(name)) addIfExists(logs, path.join(pluginDir, name), name, "LSPDFR");
      }
    } catch {
      /* ignore */
    }
  }
  if (dataDir) addIfExists(logs, path.join(dataDir, "smart-audit.jsonl"), "smart-audit.jsonl", "MANAGER");
  if (sessionRoot) {
    try {
      for (const sessionId of fs.readdirSync(sessionRoot)) {
        const excerpt = path.join(sessionRoot, sessionId, "RagePluginHook.excerpt.log");
        addIfExists(logs, excerpt, `${sessionId} excerpt`, "SESSION");
      }
    } catch {
      /* ignore */
    }
  }
  return logs.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
}

function readLog(abs, { tailLines = 200, search = "" } = {}) {
  if (!abs || !fs.existsSync(abs)) return { name: path.basename(abs || ""), text: "", truncated: false };
  const stat = fs.statSync(abs);
  const start = stat.size > MAX_BYTES ? stat.size - MAX_BYTES : 0;
  const fd = fs.openSync(abs, "r");
  const buf = Buffer.alloc(stat.size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  let text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);
  const tailed = lines.slice(-Math.max(20, Number(tailLines) || 200));
  text = tailed.join("\n");
  if (search) {
    const q = String(search).toLowerCase();
    text = tailed.filter((line) => line.toLowerCase().includes(q)).join("\n");
  }
  return {
    name: path.basename(abs),
    path: abs,
    text,
    truncated: start > 0 || lines.length > tailed.length,
    lineCount: tailed.length,
  };
}

module.exports = { listLogs, readLog, MAX_BYTES };
