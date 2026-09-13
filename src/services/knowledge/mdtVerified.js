const fs = require("fs");
const path = require("path");

const NOTE_NAME = "mdt-render.json";

function notePath(dataDir) {
  return path.join(String(dataDir || ""), NOTE_NAME);
}

function load(dataDir) {
  if (!dataDir) return null;
  try {
    const note = JSON.parse(fs.readFileSync(notePath(dataDir), "utf8"));
    if (!note || note.verified !== true) return null;
    return note;
  } catch {
    return null;
  }
}

function save(dataDir, note) {
  const dir = String(dataDir || "");
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const next = {
    schemaVersion: 1,
    verified: true,
    frameGenOff: true,
    source: "user",
    at: new Date().toISOString(),
    ...note,
  };
  fs.writeFileSync(notePath(dir), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function recordWorking(dataDir, extra = {}) {
  return save(dataDir, extra);
}

module.exports = {
  NOTE_NAME,
  notePath,
  load,
  save,
  recordWorking,
};
