const fs = require("fs");
const path = require("path");
const { KNOWN_SLOTS, SLOT_CONFIDENCE } = require("./vehicleTypes");

const DOC_NAME = /^(readme|read[\s-]?me|install|installation|how[\s-]?to|instructions)/i;
const DOC_EXT = /\.(txt|md|rtf|nfo)$/i;
const MAX_BYTES = 20_000;

const KNOWN = new Set(KNOWN_SLOTS);
const SLOT_ALT = KNOWN_SLOTS.slice().sort((a, b) => b.length - a.length).join("|");

const REPLACE_RE = new RegExp(
  `\\b(?:replace(?:s|ment)?|install(?:s|ed)?\\s+as|use\\s+as|as)\\s+(${SLOT_ALT}|[a-z][a-z0-9_]{1,24})\\b`,
  "ig"
);
const ADDON_RE = /\b(add[-\s]?on|addon|dlcpack|dlc pack|vehicle slot)\b/i;

function isDocFile(rel) {
  const base = path.basename(String(rel || "").replace(/\\/g, "/"));
  return DOC_NAME.test(base) && DOC_EXT.test(base);
}

function readDocs(scan) {
  const blobs = [];
  if (scan && scan.readmeText) blobs.push(scan.readmeText);
  for (const file of (scan && scan.usableFiles) || []) {
    if (!isDocFile(file.rel)) continue;
    try {
      blobs.push(fs.readFileSync(path.join(scan.root, file.rel.split("/").join(path.sep)), "utf8").slice(0, MAX_BYTES));
    } catch {
      /* unreadable docs are ignored */
    }
  }
  return blobs.join("\n");
}

function extractReadmeEvidence(scan) {
  const text = readDocs(scan);
  const slots = [];
  const seen = new Set();
  REPLACE_RE.lastIndex = 0;
  let match;
  while ((match = REPLACE_RE.exec(text))) {
    const slot = String(match[1] || "").toLowerCase();
    if (!slot || seen.has(slot)) continue;
    seen.add(slot);
    slots.push({
      slot,
      confidence: KNOWN.has(slot) ? SLOT_CONFIDENCE.MEDIUM : SLOT_CONFIDENCE.LOW,
      source: "README",
      evidence: match[0],
    });
  }
  return {
    text,
    slots,
    addonHint: ADDON_RE.test(text),
    mentionsVehicleSlot: /\bvehicle slot\b/i.test(text),
  };
}

module.exports = { extractReadmeEvidence, isDocFile };
