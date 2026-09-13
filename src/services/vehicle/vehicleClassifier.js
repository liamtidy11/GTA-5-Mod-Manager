const { KINDS, DISPLAY_TYPE } = require("./vehicleTypes");
const { isKnownSlot } = require("./vehicleSlotDetector");
const { normRel } = require("./vehicleAssetGrouper");

function hasAddonStructure(files = []) {
  const clues = [];
  for (const file of files) {
    const rel = normRel(file.rel || file).toLowerCase();
    const base = rel.split("/").pop();
    if (base === "content.xml" || base === "setup2.xml" || base === "dlclist.xml") clues.push(rel);
    if (/(^|\/)dlc\.rpf$/i.test(rel)) clues.push(rel);
    if (/(^|\/)dlcpacks\//i.test(rel)) clues.push(rel);
  }
  return { present: clues.length > 0, clues };
}

function distinctTopLevelContainers(files = []) {
  const tops = new Set();
  for (const file of files) {
    const parts = normRel(file.rel || file).split("/").filter(Boolean);
    if (parts.length) tops.add(parts[0].toLowerCase());
  }
  return [...tops];
}

function clearlySeparated(files, addon, replacementGroups) {
  if (!addon.present || !replacementGroups.length) return false;
  const tops = distinctTopLevelContainers(files);
  const hasReplaceDir = tops.some((t) => /replace|vanilla|slot/.test(t));
  const hasAddonDir = tops.some((t) => /dlc|addon|dlcpack/.test(t));
  return hasReplaceDir && hasAddonDir && tops.length >= 2;
}

function classifyVehicle({ groups = [], files = [], readme = {} } = {}) {
  const addon = hasAddonStructure(files);
  const vehicleGroups = groups.filter((g) => g.model || g.highDetailModel || g.texture);
  const replacementGroups = vehicleGroups.filter((g) => isKnownSlot(g.slot) && g.model);
  // README words like "optional addon" are not vehicle proof. Need models,
  // textures, or add-on DLC files before this is treated as a car pack.
  const detected = vehicleGroups.length > 0 || addon.present;

  if (!detected) {
    return {
      detected: false,
      kind: null,
      displayType: "",
      archiveRequired: false,
      addon,
      evidence: [],
    };
  }

  let kind = KINDS.UNKNOWN_VEHICLE_MOD;
  const evidence = [];
  if (replacementGroups.length) evidence.push("Known vanilla-style slot filenames.");
  if (addon.present) evidence.push(`Add-on structure: ${addon.clues.slice(0, 3).join(", ")}`);
  if (readme.addonHint) evidence.push("README mentions add-on / dlcpack.");
  if (vehicleGroups.length > 1) evidence.push(`Multiple vehicle groups: ${vehicleGroups.map((g) => g.slot).join(", ")}`);

  const mixed = replacementGroups.length > 0 && addon.present && !clearlySeparated(files, addon, replacementGroups);
  if (mixed) {
    kind = KINDS.AMBIGUOUS_VEHICLE_PACKAGE;
  } else if (vehicleGroups.length > 1) {
    kind = KINDS.VEHICLE_PACK;
  } else if (addon.present && !replacementGroups.length) {
    kind = KINDS.ADDON_VEHICLE;
  } else if (replacementGroups.length === 1) {
    kind = KINDS.REPLACE_VEHICLE;
  } else if (addon.present) {
    kind = KINDS.ADDON_VEHICLE;
  }

  return {
    detected: true,
    kind,
    displayType: DISPLAY_TYPE[kind],
    archiveRequired: true,
    addon,
    evidence,
    replacementSlots: replacementGroups.map((g) => g.slot),
  };
}

module.exports = { hasAddonStructure, classifyVehicle };
