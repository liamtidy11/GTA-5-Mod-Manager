const fs = require("fs");
const path = require("path");
const { hashBuffer, hashString } = require("../hashUtil");
const { LOG_TAIL_LINES } = require("./sessionTypes");
const { scanLogText } = require("./logSignals");

const DUTY_LOGS = [
  "RagePluginHook.log",
  path.join("plugins", "LSPDFR", "RagePluginHook.log"),
  path.join("plugins", "LSPDFR", "LSPDFR.log"),
  "asiload.log",
];

function fileMeta(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      name: path.basename(filePath),
      path: filePath,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      hash: stat.size <= 8 * 1024 * 1024 ? hashBuffer(fs.readFileSync(filePath)) : null,
    };
  } catch {
    return null;
  }
}

function locateLogs(dutyPath) {
  const found = [];
  if (!dutyPath) return found;
  for (const rel of DUTY_LOGS) {
    const abs = path.join(dutyPath, rel);
    const meta = fileMeta(abs);
    if (meta) found.push(meta);
  }
  return found;
}

function tailText(text, maxLines = LOG_TAIL_LINES) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

function readBoundedTail(filePath, maxLines = LOG_TAIL_LINES) {
  try {
    const stat = fs.statSync(filePath);
    const maxBytes = 256 * 1024;
    const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return tailText(buf.toString("utf8"), maxLines);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function collectForSession(dutyPath, options = {}) {
  const located = locateLogs(dutyPath);
  const signals = {};
  for (const log of located) {
    if (/ragepluginhook\.log/i.test(log.name) || /lspdfr\.log/i.test(log.name)) {
      try {
        Object.assign(signals, scanLogText(readBoundedTail(log.path)));
      } catch {
        /* ignore */
      }
    }
  }
  return { logs: located, signals };
}

function copyCrashExcerpts(sessionLogsDir, logs) {
  const copied = [];
  if (!sessionLogsDir) return copied;
  fs.mkdirSync(sessionLogsDir, { recursive: true });
  for (const log of logs || []) {
    const excerpt = readBoundedTail(log.path);
    if (!excerpt) continue;
    const dest = path.join(sessionLogsDir, `${log.name}.tail.txt`);
    fs.writeFileSync(dest, excerpt, "utf8");
    copied.push({
      name: log.name,
      sourcePath: log.path,
      copiedPath: dest,
      hash: hashString(excerpt),
      lines: excerpt.split(/\r?\n/).length,
    });
  }
  return copied;
}

module.exports = {
  DUTY_LOGS,
  fileMeta,
  locateLogs,
  tailText,
  readBoundedTail,
  collectForSession,
  copyCrashExcerpts,
};
