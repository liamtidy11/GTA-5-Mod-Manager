const fs = require("fs");
const path = require("path");
const { PATH_STATUS, SLOT_CONFIDENCE } = require("../vehicle/vehicleTypes");
const real = require("./realRpfBackend");
const { CODES } = require("./archiveErrors");
const { isRealRpfPath } = require("./archiveBackend");

const KNOWN_CANDIDATES = [
  "x64a.rpf",
  "x64b.rpf",
  "x64c.rpf",
  "x64d.rpf",
  "x64e.rpf",
  "x64f.rpf",
  "x64g.rpf",
  "x64h.rpf",
  "x64i.rpf",
  "x64j.rpf",
  "x64k.rpf",
  "x64l.rpf",
  "x64m.rpf",
  "x64n.rpf",
  "x64o.rpf",
  "x64p.rpf",
  "x64q.rpf",
  "x64r.rpf",
  "x64s.rpf",
  "x64t.rpf",
  "x64u.rpf",
  "x64v.rpf",
  "x64w.rpf",
  "update/update.rpf",
];

function cachePath(dataDir) {
  return path.join(dataDir, "archive-discovery-cache.json");
}

function loadCache(dataDir) {
  if (!dataDir) return { schemaVersion: 1, gtaBuild: "", entries: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(dataDir), "utf8"));
    return { schemaVersion: 1, gtaBuild: raw.gtaBuild || "", entries: raw.entries || {} };
  } catch {
    return { schemaVersion: 1, gtaBuild: "", entries: {} };
  }
}

function saveCache(dataDir, cache) {
  if (!dataDir) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cachePath(dataDir), JSON.stringify(cache, null, 2), "utf8");
}

function archiveFingerprint(archivePath) {
  try {
    const stat = fs.statSync(archivePath);
    return { archivePath: path.resolve(archivePath), archiveSize: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { archivePath: path.resolve(archivePath), archiveSize: 0, mtimeMs: 0 };
  }
}

function listDutyCandidateArchives(dutyPath, officialPath = "") {
  if (!dutyPath) return [];
  const out = [];
  for (const rel of KNOWN_CANDIDATES) {
    const abs = path.join(dutyPath, rel.split("/").join(path.sep));
    if (!fs.existsSync(abs)) continue;
    if (officialPath && path.resolve(abs).toLowerCase().startsWith(path.resolve(officialPath).toLowerCase() + path.sep)) {
      continue;
    }
    out.push(abs);
  }
  return out;
}

function expectedNamesForSlot(slot) {
  const name = String(slot || "").toLowerCase();
  return [`${name}.yft`, `${name}_hi.yft`, `${name}.ytd`];
}

function groupKey(archivePath, entryPath) {
  const dir = String(entryPath || "").replace(/\\/g, "/").replace(/\/[^/]+$/, "");
  return `${path.resolve(archivePath)}::${dir}`;
}

function findEntriesByName(names, candidateArchives, options = {}) {
  const wanted = new Set((names || []).map((n) => String(n).toLowerCase()));
  const matches = [];
  const inspectErrors = [];
  const started = Date.now();
  for (const archivePath of candidateArchives || []) {
    if (options.signal && options.signal.aborted) break;
    if (typeof options.cancelled === "function" && options.cancelled()) break;
    if (options.timeoutMs && Date.now() - started > options.timeoutMs) break;
    if (!isRealRpfPath(archivePath) && options.requireRpf !== false) continue;
    let handle;
    try {
      handle = real.openArchive(archivePath, {
        mode: "readOnly",
        officialPath: options.officialPath,
        allowOnlineRead: options.allowOnlineRead,
      });
      for (const entry of real.listEntries(handle)) {
        const base = entry.split("/").pop().toLowerCase();
        if (wanted.has(base)) {
          matches.push({
            archive: path.basename(archivePath),
            archivePath: path.resolve(archivePath),
            entry,
            name: base,
            entryBase: entry.replace(/\/[^/]+$/, ""),
          });
        }
      }
    } catch (error) {
      inspectErrors.push({
        archivePath,
        code: error && error.code ? error.code : CODES.ARCHIVE_READ_ERROR,
        message: error && error.message ? error.message : String(error),
      });
      if (options.onError) options.onError(archivePath, error);
      continue;
    } finally {
      if (handle) real.close(handle);
    }
  }
  matches.inspectErrors = inspectErrors;
  return matches;
}

function scoreGroup(group, expected) {
  const have = new Set(group.map((row) => row.name));
  const model = expected.find((n) => n.endsWith(".yft") && !n.endsWith("_hi.yft"));
  const hi = expected.find((n) => n.endsWith("_hi.yft"));
  const tex = expected.find((n) => n.endsWith(".ytd"));
  if (model && hi && tex && have.has(model) && have.has(hi) && have.has(tex)) {
    return SLOT_CONFIDENCE.HIGH;
  }
  if (model && tex && have.has(model) && have.has(tex)) return SLOT_CONFIDENCE.MEDIUM;
  if (have.size === 1) return SLOT_CONFIDENCE.LOW;
  return SLOT_CONFIDENCE.LOW;
}

function findVehicleSlot(slot, options = {}) {
  const names = options.names || expectedNamesForSlot(slot);
  const archives = options.candidateArchives || [];
  const matches = findEntriesByName(names, archives, options);
  const inspectErrors = matches.inspectErrors || [];
  const groups = new Map();
  for (const row of matches) {
    const key = groupKey(row.archivePath, row.entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const scored = [...groups.entries()].map(([key, rows]) => ({
    key,
    rows,
    confidence: scoreGroup(rows, names),
    archivePath: rows[0].archivePath,
    archive: rows[0].archive,
    entryBase: rows[0].entryBase,
  }));
  const complete = scored.filter((g) => g.confidence === SLOT_CONFIDENCE.HIGH);
  const medium = scored.filter((g) => g.confidence === SLOT_CONFIDENCE.MEDIUM);

  if (complete.length === 1 && scored.length === 1) {
    return {
      slot,
      status: PATH_STATUS.DISCOVERED,
      confidence: SLOT_CONFIDENCE.HIGH,
      archive: complete[0].archive,
      archivePath: complete[0].archivePath,
      entryBase: complete[0].entryBase,
      matches: complete[0].rows,
      evidence: "All expected assets are co-located.",
    };
  }
  if (complete.length > 1 || (complete.length === 1 && scored.length > 1)) {
    return {
      slot,
      status: PATH_STATUS.AMBIGUOUS,
      confidence: SLOT_CONFIDENCE.UNKNOWN,
      candidates: complete.length > 1 ? complete : scored,
      matches,
      evidence: "The same filename exists in more than one archive.",
    };
  }
  if (medium.length > 1) {
    return {
      slot,
      status: PATH_STATUS.AMBIGUOUS,
      confidence: SLOT_CONFIDENCE.MEDIUM,
      candidates: medium,
      matches,
      evidence: "Multiple model+texture locations.",
    };
  }
  if (medium.length === 1 && scored.length === 1) {
    return {
      slot,
      status: PATH_STATUS.DISCOVERED,
      confidence: SLOT_CONFIDENCE.MEDIUM,
      archive: medium[0].archive,
      archivePath: medium[0].archivePath,
      entryBase: medium[0].entryBase,
      matches: medium[0].rows,
      evidence: "Model and texture are co-located. _hi model is absent.",
    };
  }
  if (scored.length > 1) {
    return {
      slot,
      status: PATH_STATUS.AMBIGUOUS,
      confidence: SLOT_CONFIDENCE.LOW,
      candidates: scored,
      matches,
      evidence: "The same filename exists in more than one archive.",
    };
  }
  if (scored.length === 1) {
    return {
      slot,
      status: PATH_STATUS.DISCOVERED,
      confidence: SLOT_CONFIDENCE.LOW,
      archive: scored[0].archive,
      archivePath: scored[0].archivePath,
      entryBase: scored[0].entryBase,
      matches: scored[0].rows,
      evidence: "Only one matching file was found.",
    };
  }
  const inspected = archives.filter((archivePath) => isRealRpfPath(archivePath) || options.requireRpf === false);
  const inspectFailed = inspected.length > 0 && inspectErrors.length === inspected.length;
  return {
    slot,
    status: PATH_STATUS.UNKNOWN,
    confidence: SLOT_CONFIDENCE.UNKNOWN,
    matches: [],
    inspectFailed,
    inspectErrors,
    readError: inspectErrors.some((row) => row.code === CODES.ARCHIVE_READ_ERROR),
    evidence: inspectFailed ? "archive could not be inspected" : "No matching archive entries.",
  };
}

function cacheFresh(cached, gtaBuild, archives) {
  if (!cached) return false;
  if (String(cached.gtaBuild || "") !== String(gtaBuild || "")) return false;
  for (const archivePath of archives || []) {
    const live = archiveFingerprint(archivePath);
    const known = (cached.archives || []).find((row) => path.resolve(row.archivePath) === live.archivePath);
    if (!known || known.archiveSize !== live.archiveSize || known.mtimeMs !== live.mtimeMs) return false;
  }
  return true;
}

function discoverCached(slot, options = {}) {
  const archives = options.candidateArchives || [];
  const gtaBuild = options.gtaBuild || "";
  const cache = loadCache(options.dataDir);
  if (cache.gtaBuild && gtaBuild && cache.gtaBuild !== gtaBuild) {
    cache.entries = {};
    cache.gtaBuild = gtaBuild;
  }
  const key = String(slot || "").toLowerCase();
  const cached = cache.entries[key];
  if (cached && cacheFresh(cached, gtaBuild, archives)) {
    return { ...cached.result, fromCache: true };
  }
  const result = findVehicleSlot(slot, options);
  cache.gtaBuild = gtaBuild;
  cache.entries[key] = {
    gtaBuild,
    slot: key,
    archives: archives.map(archiveFingerprint),
    result,
  };
  saveCache(options.dataDir, cache);
  return { ...result, fromCache: false };
}

module.exports = {
  KNOWN_CANDIDATES,
  listDutyCandidateArchives,
  expectedNamesForSlot,
  findEntriesByName,
  findVehicleSlot,
  discoverCached,
  loadCache,
  saveCache,
  cachePath,
  archiveFingerprint,
};
