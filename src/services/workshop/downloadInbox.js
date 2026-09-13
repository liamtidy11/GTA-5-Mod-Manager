const fs = require("fs");
const path = require("path");

const ARCHIVE = /\.(zip|rar|7z|oiv)$/i;

const NOT_GAME =
  /davinci|resolve|msfs|fs24|qantas|batc|aviatordesign|aviatorpilot|ypph-perth|mrr-a380|flight.?sim/i;

function likelyGameArchive(name) {
  const file = String(name || "");
  if (!ARCHIVE.test(file)) return false;
  if (NOT_GAME.test(file)) return false;
  return true;
}

function inboxPath(root) {
  return path.join(root, "inbox.json");
}

function empty() {
  return { schemaVersion: 1, items: {}, ignored: [], watch: null };
}

function load(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(inboxPath(root), "utf8"));
    return {
      schemaVersion: 1,
      items: raw.items && typeof raw.items === "object" ? raw.items : {},
      ignored: Array.isArray(raw.ignored) ? raw.ignored.map(String) : [],
      watch: raw.watch && typeof raw.watch === "object" ? raw.watch : null,
    };
  } catch {
    return empty();
  }
}

function save(root, data) {
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${inboxPath(root)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ schemaVersion: 1, items: data.items || {}, ignored: data.ignored || [], watch: data.watch || null }, null, 2)}\n`);
  fs.renameSync(tmp, inboxPath(root));
  return data;
}

function listArchives(dir) {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((row) => row.isFile() && ARCHIVE.test(row.name))
      .map((row) => {
        const filePath = path.join(dir, row.name);
        const stat = fs.statSync(filePath);
        return { path: filePath, name: row.name, size: stat.size, mtimeMs: stat.mtimeMs };
      });
  } catch {
    return [];
  }
}

function startWatch(root, { workshopId, expected, sinceMs = Date.now() } = {}) {
  const db = load(root);
  db.watch = { workshopId, expected, sinceMs };
  return save(root, db);
}

function clearWatch(root) {
  const db = load(root);
  db.watch = null;
  return save(root, db);
}

function ignore(root, filePath) {
  const db = load(root);
  if (filePath && !db.ignored.includes(filePath)) db.ignored.push(filePath);
  if (db.items[filePath]) db.items[filePath].state = "IGNORED";
  return save(root, db);
}

function markRecognized(root, filePath, recognition = {}) {
  const db = load(root);
  const item = db.items[filePath] || { path: filePath };
  item.recognition = recognition;
  item.state = recognition.unknown ? "UNKNOWN" : "RECOGNIZED";
  db.items[filePath] = item;
  return save(root, db);
}

function markInstalled(root, filePath) {
  const db = load(root);
  if (db.items[filePath]) db.items[filePath].state = "INSTALLED";
  return save(root, db);
}

function scan(root, downloadDir, { nowMs = Date.now() } = {}) {
  const db = load(root);
  const files = listArchives(downloadDir);
  const sinceMs = (db.watch && db.watch.sinceMs) || 0;
  for (const file of files) {
    const existing = db.items[file.path];
    if (db.ignored.includes(file.path)) {
      db.items[file.path] = { ...file, state: "IGNORED", recognition: existing && existing.recognition };
      continue;
    }
    if (existing && existing.state === "INSTALLED") {
      db.items[file.path] = { ...existing, ...file, state: "INSTALLED" };
      continue;
    }
    if (existing && (existing.state === "RECOGNIZED" || existing.state === "UNKNOWN")) {
      db.items[file.path] = { ...existing, ...file };
      continue;
    }
    const fresh = !sinceMs || file.mtimeMs >= sinceMs - 1000;
    db.items[file.path] = {
      ...file,
      state: existing && existing.state ? existing.state : fresh ? "NEW" : "NEW",
      seenAt: nowMs,
      expected: db.watch ? db.watch.expected : null,
    };
  }
  return save(root, db);
}

function list(root) {
  const db = load(root);
  return Object.values(db.items).sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
}

function pendingNew(root) {
  return list(root).filter((row) => row.state === "NEW");
}

function listWatchedNew(root) {
  const db = load(root);
  if (!db.watch) return [];
  const since = Number(db.watch.sinceMs) || 0;
  return list(root).filter(
    (row) =>
      row.state === "NEW" &&
      Number(row.mtimeMs || 0) >= since - 1000 &&
      likelyGameArchive(row.name)
  );
}

function listGameArchives(root) {
  return list(root).filter((row) => row.state !== "IGNORED" && likelyGameArchive(row.name));
}

module.exports = {
  ARCHIVE,
  likelyGameArchive,
  inboxPath,
  load,
  save,
  listArchives,
  startWatch,
  clearWatch,
  ignore,
  markRecognized,
  markInstalled,
  scan,
  list,
  listGameArchives,
  listWatchedNew,
  pendingNew,
};
