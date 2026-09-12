const { KNOWN_SLOTS, SLOT_CONFIDENCE } = require("./vehicleTypes");
const { stemFromName, isVehicleArchiveAsset, normRel } = require("./vehicleAssetGrouper");

const KNOWN = new Set(KNOWN_SLOTS);

function slotFromFilename(relOrBase) {
  const name = String(relOrBase || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop();
  if (!isVehicleArchiveAsset(name)) return null;
  const slot = stemFromName(name);
  if (!slot) return null;
  return {
    slot,
    confidence: KNOWN.has(slot) ? SLOT_CONFIDENCE.HIGH : SLOT_CONFIDENCE.UNKNOWN,
    source: "FILENAME",
    evidence: name,
  };
}

function slotsFromFolder(rel) {
  const parts = normRel(rel)
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  const hits = [];
  for (const part of parts.slice(0, -1)) {
    if (KNOWN.has(part)) {
      hits.push({
        slot: part,
        confidence: SLOT_CONFIDENCE.MEDIUM,
        source: "FOLDER",
        evidence: part,
      });
    }
  }
  return hits;
}

function strongestSlot(candidates = []) {
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
  let best = null;
  for (const item of candidates) {
    if (!item || !item.slot) continue;
    if (!best || rank[item.confidence] > rank[best.confidence]) best = item;
    else if (best && item.source === "FILENAME" && best.source !== "FILENAME" && rank[item.confidence] === rank[best.confidence]) {
      best = item;
    }
  }
  return best;
}

function detectSlots({ files = [], readmeSlots = [] } = {}) {
  const bySlot = new Map();

  function add(hit) {
    if (!hit || !hit.slot) return;
    const current = bySlot.get(hit.slot) || { slot: hit.slot, evidence: [], confidence: SLOT_CONFIDENCE.UNKNOWN };
    current.evidence.push(hit);
    const rank = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
    if (rank[hit.confidence] > rank[current.confidence]) current.confidence = hit.confidence;
    if (hit.source === "FILENAME" && KNOWN.has(hit.slot)) current.confidence = SLOT_CONFIDENCE.HIGH;
    bySlot.set(hit.slot, current);
  }

  for (const file of files) {
    add(slotFromFilename(file.base || file.rel));
    for (const folder of slotsFromFolder(file.rel)) add(folder);
  }
  for (const readme of readmeSlots) add(readme);

  return [...bySlot.values()].sort((a, b) => a.slot.localeCompare(b.slot));
}

module.exports = {
  slotFromFilename,
  slotsFromFolder,
  strongestSlot,
  detectSlots,
  isKnownSlot: (slot) => KNOWN.has(String(slot || "").toLowerCase()),
};
