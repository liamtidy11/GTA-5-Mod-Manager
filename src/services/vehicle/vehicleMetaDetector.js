const path = require("path");
const { META_NAMES } = require("./vehicleTypes");
const { normRel } = require("./vehicleAssetGrouper");

const META_SET = new Set(META_NAMES);

function isMetaFile(relOrBase) {
  const name = path.posix.basename(normRel(relOrBase)).toLowerCase();
  return META_SET.has(name) || (name.endsWith(".meta") && /vehicle|handling|carcol|carvariation/i.test(name));
}

function detectMetadata(files = [], slots = []) {
  const metas = [];
  const seenNames = new Map();
  const packageLevel = [];
  const associated = {};

  for (const file of files) {
    const rel = normRel(file.rel || file);
    const name = path.posix.basename(rel).toLowerCase();
    if (!isMetaFile(name)) continue;
    const record = { rel, name, associatedSlot: null };
    metas.push(record);
    seenNames.set(name, (seenNames.get(name) || 0) + 1);

    const folder = path.posix.dirname(rel).toLowerCase();
    const folderHit = slots.find((slot) => folder.split("/").includes(slot));
    if (folderHit) {
      record.associatedSlot = folderHit;
      associated[folderHit] = associated[folderHit] || [];
      associated[folderHit].push(name);
    } else {
      packageLevel.push(record);
    }
  }

  if (slots.length === 1) {
    for (const meta of packageLevel) {
      meta.associatedSlot = slots[0];
      associated[slots[0]] = associated[slots[0]] || [];
      if (!associated[slots[0]].includes(meta.name)) associated[slots[0]].push(meta.name);
    }
  }

  const duplicates = [...seenNames.entries()].filter(([, count]) => count > 1).map(([name]) => name);

  return {
    files: metas,
    packageLevel: metas.filter((m) => !m.associatedSlot).map((m) => m.name),
    associated,
    duplicates,
  };
}

module.exports = { isMetaFile, detectMetadata };
