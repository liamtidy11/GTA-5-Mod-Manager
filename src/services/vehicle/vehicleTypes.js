// Shared vehicle-intelligence constants. Recognition is not installation.

const KINDS = {
  REPLACE_VEHICLE: "REPLACE_VEHICLE",
  ADDON_VEHICLE: "ADDON_VEHICLE",
  VEHICLE_PACK: "VEHICLE_PACK",
  UNKNOWN_VEHICLE_MOD: "UNKNOWN_VEHICLE_MOD",
  AMBIGUOUS_VEHICLE_PACKAGE: "AMBIGUOUS_VEHICLE_PACKAGE",
};

const DISPLAY_TYPE = {
  REPLACE_VEHICLE: "Vehicle Replacement",
  ADDON_VEHICLE: "Add-On Vehicle",
  VEHICLE_PACK: "Vehicle Pack",
  UNKNOWN_VEHICLE_MOD: "Vehicle Mod",
  AMBIGUOUS_VEHICLE_PACKAGE: "Ambiguous Vehicle Package",
};

const SLOT_CONFIDENCE = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  UNKNOWN: "UNKNOWN",
};

const PATH_STATUS = {
  VERIFIED: "VERIFIED",
  DISCOVERED: "DISCOVERED",
  AMBIGUOUS: "AMBIGUOUS",
  UNKNOWN: "UNKNOWN",
  UNSUPPORTED: "UNSUPPORTED",
};

const OP_STATUS = {
  READY: "READY",
  UNKNOWN_TARGET: "UNKNOWN_TARGET",
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",
  CONFLICT: "CONFLICT",
  UNSUPPORTED: "UNSUPPORTED",
};

const TARGET_STATE = {
  VANILLA: "VANILLA",
  MANAGED_MOD: "MANAGED_MOD",
  EXTERNALLY_MODIFIED: "EXTERNALLY_MODIFIED",
  UNKNOWN: "UNKNOWN",
};

const KNOWN_SLOTS = [
  "police",
  "police2",
  "police3",
  "police4",
  "sheriff",
  "sheriff2",
  "fbi",
  "fbi2",
  "riot",
  "pranger",
  "ambulance",
  "firetruk",
];

const META_NAMES = [
  "vehicles.meta",
  "handling.meta",
  "carvariations.meta",
  "carcols.meta",
  "dlclist.xml",
  "content.xml",
  "setup2.xml",
];

module.exports = {
  KINDS,
  DISPLAY_TYPE,
  SLOT_CONFIDENCE,
  PATH_STATUS,
  OP_STATUS,
  TARGET_STATE,
  KNOWN_SLOTS,
  META_NAMES,
};
