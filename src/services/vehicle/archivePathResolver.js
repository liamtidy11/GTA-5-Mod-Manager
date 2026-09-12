const fs = require("fs");
const path = require("path");
const { PATH_STATUS } = require("./vehicleTypes");
const { isRealRpfPath } = require("../archive/archiveBackend");
const { CODES, ArchiveError } = require("../archive/archiveErrors");
const discoveryIndex = require("../archive/archiveIndex");

const PRODUCTION_MAP = path.join(__dirname, "..", "..", "data", "vehicleArchivePaths.json");

function loadPathMap(override) {
  if (override && typeof override === "object") return normalizeMap(override);
  if (typeof override === "string") {
    return normalizeMap(JSON.parse(fs.readFileSync(override, "utf8")));
  }
  try {
    return normalizeMap(JSON.parse(fs.readFileSync(PRODUCTION_MAP, "utf8")));
  } catch {
    return { schemaVersion: 1, edition: "Enhanced", vehicleSlots: {} };
  }
}

function normalizeMap(raw) {
  return {
    schemaVersion: Number(raw && raw.schemaVersion) || 1,
    edition: (raw && raw.edition) || "Enhanced",
    vehicleSlots: (raw && raw.vehicleSlots) || {},
  };
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function joinEntry(entryBase, fileName) {
  const base = String(entryBase || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const name = String(fileName || "").replace(/\\/g, "/").split("/").pop();
  if (!base || !name) return name || "";
  return `${base}/${name}`;
}

// Future Phase 3C/3D hook. Accepts a fake index in tests only.
// Never opens a real GTA archive.
function discoverSlotInIndex(slot, archiveIndex = []) {
  const needle = String(slot || "").toLowerCase();
  const hits = (archiveIndex || []).filter((row) => {
    const entry = String((row && row.entry) || "").replace(/\\/g, "/").toLowerCase();
    const name = entry.split("/").pop();
    return row.slot === needle || name === `${needle}.yft` || name === `${needle}.ytd` || name === `${needle}_hi.yft`;
  });
  if (hits.length === 1) {
    return {
      status: PATH_STATUS.DISCOVERED,
      archive: hits[0].archive,
      entryBase: hits[0].entryBase || hits[0].entry.replace(/\/[^/]+$/, ""),
      evidence: "Single exact match in provided archive index.",
    };
  }
  if (hits.length > 1) {
    return {
      status: PATH_STATUS.AMBIGUOUS,
      candidates: hits,
      evidence: "Multiple archive-index matches.",
    };
  }
  return null;
}

function resolveSlot(slot, options = {}) {
  const { pathMap, archiveIndex } = options;
  const name = String(slot || "").toLowerCase();
  const map = loadPathMap(pathMap);
  const raw = map.vehicleSlots[name];
  const rows = asList(raw);

  if (rows.length > 1) {
    return {
      slot: name,
      status: PATH_STATUS.AMBIGUOUS,
      archive: null,
      entryBase: null,
      candidates: rows,
      evidence: "Multiple mappings exist for this slot.",
    };
  }

  if (rows.length === 1) {
    const row = rows[0];
    const status = row.status || PATH_STATUS.VERIFIED;
    if (status === PATH_STATUS.VERIFIED || status === PATH_STATUS.AMBIGUOUS || status === PATH_STATUS.UNSUPPORTED) {
      return {
        slot: name,
        status,
        archive: row.archive || null,
        entryBase: row.entryBase || null,
        evidence: status === PATH_STATUS.VERIFIED ? "Verified mapping." : `${status} mapping.`,
      };
    }
  }

  if (options.discovery && options.discovery.status) {
    return { slot: name, ...options.discovery };
  }

  if (options.discoverOptions && (options.discoverOptions.candidateArchives || []).length) {
    try {
      const live = discoveryIndex.discoverCached(name, options.discoverOptions);
      if (live && live.status && live.status !== PATH_STATUS.UNKNOWN) return { slot: name, ...live };
      if (live && (live.inspectFailed || live.readError)) return { slot: name, ...live };
    } catch {
      return {
        slot: name,
        status: PATH_STATUS.UNKNOWN,
        archive: null,
        entryBase: null,
        inspectFailed: true,
        evidence: "archive could not be inspected",
      };
    }
  }

  const discovered = discoverSlotInIndex(name, archiveIndex);
  if (discovered) return { slot: name, ...discovered };

  return {
    slot: name,
    status: PATH_STATUS.UNKNOWN,
    archive: null,
    entryBase: null,
    evidence: "No independently verified GTA V Enhanced archive path.",
  };
}

function resolveAsset(slot, fileName, options = {}) {
  const resolved = resolveSlot(slot, options);
  return {
    ...resolved,
    fileName,
    entry: resolved.entryBase ? joinEntry(resolved.entryBase, fileName) : null,
  };
}

function rejectRealArchive(archivePath) {
  if (isRealRpfPath(archivePath)) {
    throw new ArchiveError(
      CODES.REAL_ARCHIVE_BACKEND_NOT_AVAILABLE,
      "Real GTA archive backend is not available.",
      { file: archivePath }
    );
  }
}

module.exports = {
  PRODUCTION_MAP,
  loadPathMap,
  discoverSlotInIndex,
  resolveSlot,
  resolveAsset,
  joinEntry,
  rejectRealArchive,
};
