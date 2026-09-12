const path = require("path");
const { KNOWN_SLOTS, SLOT_CONFIDENCE } = require("./vehicleTypes");

function normRel(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function baseName(rel) {
  return path.posix.basename(normRel(rel)).toLowerCase();
}

function isHiModel(name) {
  return /_hi\.yft$/i.test(name);
}

function isModel(name) {
  return /\.yft$/i.test(name) && !isHiModel(name);
}

function isTexture(name) {
  return /\.ytd$/i.test(name);
}

function isVehicleAssetName(name) {
  return isModel(name) || isHiModel(name) || isTexture(name);
}

function isVehicleArchiveAsset(rel) {
  const name = baseName(rel);
  return isVehicleAssetName(name);
}

function stemFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (isHiModel(lower)) return lower.replace(/_hi\.yft$/i, "");
  if (isModel(lower)) return lower.replace(/\.yft$/i, "");
  if (isTexture(lower)) return lower.replace(/\.ytd$/i, "");
  return "";
}

function assetRole(name) {
  if (isHiModel(name)) return "highDetailModel";
  if (isModel(name)) return "model";
  if (isTexture(name)) return "texture";
  return "";
}

function emptyGroup(slot) {
  return {
    slot,
    model: null,
    highDetailModel: null,
    texture: null,
    extras: [],
    warnings: [],
    confidence: KNOWN_SLOTS.includes(slot) ? SLOT_CONFIDENCE.HIGH : SLOT_CONFIDENCE.UNKNOWN,
    evidence: [],
  };
}

function fileRef(file) {
  return {
    rel: normRel(file.rel || file),
    base: file.base || path.posix.basename(normRel(file.rel || file)),
  };
}

function groupVehicleAssets(files = []) {
  const groups = new Map();
  const warnings = [];

  for (const file of files) {
    const name = (file.base || baseName(file.rel)).toLowerCase();
    const role = assetRole(name);
    if (!role) continue;
    const slot = stemFromName(name);
    if (!slot) continue;
    if (!groups.has(slot)) groups.set(slot, emptyGroup(slot));
    const group = groups.get(slot);
    const ref = fileRef(file);
    group.evidence.push({ source: "FILENAME", file: ref.rel, role });

    if (role === "texture" && group.texture && group.texture.rel !== ref.rel) {
      group.extras.push(ref);
      group.warnings.push("multiple textures for same slot");
      warnings.push(`${slot}: multiple textures for same slot`);
      continue;
    }
    if (group[role] && group[role].rel !== ref.rel) {
      group.extras.push(ref);
      group.warnings.push(`duplicate slot files (${role})`);
      warnings.push(`${slot}: duplicate slot files`);
      continue;
    }
    group[role] = ref;
  }

  const list = [...groups.values()].sort((a, b) => a.slot.localeCompare(b.slot));
  for (const group of list) {
    if (!group.model) {
      group.warnings.push("missing .yft");
      warnings.push(`${group.slot}: missing .yft`);
    }
    if (group.model && !group.highDetailModel) {
      group.warnings.push("missing _hi.yft");
      warnings.push(`${group.slot}: missing _hi.yft`);
    }
    if (!group.texture) {
      group.warnings.push("missing .ytd");
      warnings.push(`${group.slot}: missing .ytd`);
    }
  }

  return { groups: list, warnings };
}

module.exports = {
  normRel,
  baseName,
  isHiModel,
  isModel,
  isTexture,
  isVehicleArchiveAsset,
  stemFromName,
  assetRole,
  groupVehicleAssets,
};
