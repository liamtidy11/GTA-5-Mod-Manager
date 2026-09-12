const path = require("path");
const registry = require("./registry");
const manifestStore = require("./manifestStore");
const modKnowledge = require("./modKnowledge");
const versionDetector = require("./versionDetector");

// Multi-signal recognition against the local knowledge catalog.
// Recognition confidence is not compatibility.

const WEIGHTS = {
  DLL_NAME: 0.7,
  CONFIG_NAME: 0.2,
  ARCHIVE_PATTERN: 0.18,
  FOLDER_PATTERN: 0.15,
  ALIAS: 0.18,
  CLASSIFICATION: 0.08,
};

function bandFor(confidence) {
  if (confidence >= 0.9) return "HIGH";
  if (confidence >= 0.7) return "GOOD";
  if (confidence >= 0.4) return "LOW";
  return "UNKNOWN";
}

function lower(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function baseName(rel) {
  return path.basename(lower(rel));
}

function compact(text) {
  return lower(text).replace(/[^a-z0-9]+/g, "");
}

function fileList(scan) {
  return (scan.usableFiles || scan.files || []).map((f) => (typeof f === "string" ? f : f.rel));
}

function collectSignals(entry, context) {
  const signals = [];
  const rec = entry.recognition || {};
  const files = context.files || [];
  const bases = new Set(files.map(baseName));
  const archive = lower(context.archiveName || "");
  const archiveCompact = compact(context.archiveName || "");

  for (const dll of rec.dllNames || []) {
    if (bases.has(lower(dll))) {
      signals.push({ type: "DLL_NAME", value: dll, source: "FILENAME", weight: WEIGHTS.DLL_NAME });
    }
  }
  for (const cfg of rec.configNames || []) {
    if (bases.has(lower(cfg))) {
      signals.push({ type: "CONFIG_NAME", value: cfg, source: "FILENAME", weight: WEIGHTS.CONFIG_NAME });
    }
  }
  for (const pattern of rec.archivePatterns || []) {
    const p = lower(pattern);
    if (p && (archive.includes(p) || archiveCompact.includes(compact(p)))) {
      signals.push({ type: "ARCHIVE_PATTERN", value: pattern, source: "FILENAME", weight: WEIGHTS.ARCHIVE_PATTERN });
    }
  }
  for (const folder of rec.folderPatterns || []) {
    const needle = lower(folder).replace(/\/+$/, "");
    if (files.some((rel) => lower(rel).includes(`${needle}/`) || lower(rel).startsWith(`${needle}/`))) {
      signals.push({ type: "FOLDER_PATTERN", value: folder, source: "FOLDER_STRUCTURE", weight: WEIGHTS.FOLDER_PATTERN });
    }
  }
  for (const alias of [entry.name, ...(entry.aliases || [])]) {
    const a = compact(alias);
    if (a && archiveCompact.includes(a) && a.length >= 4) {
      signals.push({ type: "ALIAS", value: alias, source: "FILENAME", weight: WEIGHTS.ALIAS });
    }
  }
  if (context.classificationType && entry.category && context.classificationType === entry.category) {
    signals.push({
      type: "CLASSIFICATION",
      value: entry.category,
      source: "FOLDER_STRUCTURE",
      weight: WEIGHTS.CLASSIFICATION,
    });
  }

  const seen = new Set();
  const unique = [];
  for (const signal of signals) {
    const key = `${signal.type}:${lower(signal.value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(signal);
  }
  return unique;
}

function score(signals) {
  const best = new Map();
  for (const signal of signals) {
    const current = best.get(signal.type) || 0;
    if ((signal.weight || 0) > current) best.set(signal.type, signal.weight || 0);
  }
  const total = [...best.values()].reduce((sum, w) => sum + w, 0);
  return Math.min(1, Number(total.toFixed(3)));
}

function emptyRecognition(context) {
  return {
    modId: null,
    name: context.archiveName || "Unknown",
    category: context.classificationType || "UNKNOWN",
    confidence: 0,
    band: "UNKNOWN",
    signals: [],
    knowledge: null,
    candidates: [],
    ambiguous: false,
  };
}

function recognize(scan, context = {}) {
  const db = context.database || modKnowledge.load({ userPath: context.userPath });
  const files = fileList(scan);
  const ctx = {
    files,
    archiveName: context.archiveName || "",
    classificationType: context.classificationType || "",
  };

  const scored = [];
  for (const entry of db.mods || []) {
    const signals = collectSignals(entry, ctx);
    if (!signals.length) continue;
    const confidence = score(signals);
    scored.push({
      modId: entry.id,
      name: entry.name,
      category: entry.category,
      confidence,
      band: bandFor(confidence),
      signals,
      knowledge: entry,
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  const candidates = scored.filter((item) => item.confidence >= 0.4).slice(0, 5);
  const identified = scored.filter((item) => item.confidence >= 0.4 && item.signals.some((s) => s.type === "DLL_NAME"));
  const ambiguous =
    identified.length >= 2 && Math.abs(identified[0].confidence - identified[1].confidence) < 0.05;

  const best = identified[0] || scored[0] || null;
  if (ambiguous) {
    return {
      ...emptyRecognition(ctx),
      confidence: identified[0].confidence,
      band: identified[0].band,
      signals: identified[0].signals,
      candidates: identified.slice(0, 4).map((item) => ({
        modId: item.modId,
        name: item.name,
        confidence: item.confidence,
        band: item.band,
      })),
      ambiguous: true,
    };
  }
  if (!best || !identified.length) {
    const fallback = emptyRecognition(ctx);
    if (best) {
      fallback.confidence = best.confidence;
      fallback.signals = best.signals;
      fallback.category = context.classificationType || best.category || fallback.category;
    }
    fallback.candidates = candidates.map((item) => ({
      modId: item.modId,
      name: item.name,
      confidence: item.confidence,
      band: item.band,
    }));
    return fallback;
  }
  return {
    ...best,
    candidates: candidates.map((item) => ({
      modId: item.modId,
      name: item.name,
      confidence: item.confidence,
      band: item.band,
    })),
    ambiguous: false,
  };
}

function installedRecords({ dutyPath, dataDir }) {
  const rows = [];
  if (dutyPath) {
    for (const mod of registry.load(dutyPath).mods) {
      rows.push({
        id: mod.id,
        name: mod.name,
        version: mod.version || "UNKNOWN",
        files: (mod.files || []).map((f) => String(f)),
        source: "REGISTRY",
        enabled: mod.enabled !== false,
      });
    }
  }
  if (dataDir) {
    for (const mod of manifestStore.list(dataDir)) {
      rows.push({
        id: mod.id,
        name: mod.name,
        version: mod.version || "UNKNOWN",
        files: (mod.files || []).map((f) => f.destination || f),
        source: "MANIFEST",
        enabled: mod.enabled !== false,
        canonicalModId: mod.canonicalModId || mod.recognitionModId || "",
      });
    }
  }
  return rows;
}

function detectInstalled(recognition, { dutyPath = "", dataDir = "", droppedVersion = "UNKNOWN" } = {}) {
  const result = {
    alreadyInstalled: false,
    possibleUpdate: false,
    relation: "NEW",
    installed: null,
    dropped: { version: droppedVersion || "UNKNOWN" },
  };
  if (!recognition || !recognition.modId || recognition.band === "UNKNOWN") return result;

  const dlls = new Set((recognition.knowledge && recognition.knowledge.recognition.dllNames || []).map(lower));
  const records = installedRecords({ dutyPath, dataDir });
  const match = records.find((row) =>
    row.canonicalModId === recognition.modId || (row.files || []).some((file) => dlls.has(baseName(file)))
  );
  if (!match) return result;

  result.alreadyInstalled = true;
  result.installed = {
    id: match.id,
    name: match.name,
    version: match.version || "UNKNOWN",
    source: match.source,
    enabled: match.enabled,
  };

  const cmp = versionDetector.compareVersions(droppedVersion, match.version);
  if (cmp == null) {
    result.possibleUpdate = true;
    result.relation = "UNKNOWN";
  } else if (cmp > 0) {
    result.possibleUpdate = true;
    result.relation = "UPDATE";
  } else if (cmp < 0) {
    result.possibleUpdate = false;
    result.relation = "DOWNGRADE";
  } else {
    result.possibleUpdate = false;
    result.relation = "SAME";
  }
  return result;
}

module.exports = {
  recognize,
  detectInstalled,
  bandFor,
  WEIGHTS,
};
