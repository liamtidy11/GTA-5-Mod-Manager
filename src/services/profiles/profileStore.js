const fs = require("fs");
const path = require("path");
const { SCHEMA_VERSION } = require("./profileTypes");
const { atomicWrite } = require("./managedState");

function indexPath(root) {
  return path.join(root, "index.json");
}

function profileDir(root, profileId) {
  return path.join(root, profileId);
}

function profileFile(root, profileId) {
  return path.join(profileDir(root, profileId), "profile.json");
}

function configBlobRoot(root, profileId) {
  return path.join(profileDir(root, profileId), "configs");
}

function emptyIndex() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeProfileId: null,
    knownGoodProfileId: null,
    drifted: false,
    driftNotes: [],
    profiles: [],
  };
}

function loadIndex(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    return { ...emptyIndex(), ...raw, profiles: Array.isArray(raw.profiles) ? raw.profiles : [] };
  } catch {
    return emptyIndex();
  }
}

function saveIndex(root, index) {
  atomicWrite(indexPath(root), `${JSON.stringify({ ...index, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);
}

function toIndexRow(profile) {
  return {
    profileId: profile.profileId,
    name: profile.name,
    knownGood: Boolean(profile.knownGood),
    health: profile.health || "HEALTHY",
    modCount: Array.isArray(profile.mods) ? profile.mods.length : 0,
    updatedAt: profile.updatedAt,
  };
}

function writeProfile(root, profile) {
  fs.mkdirSync(profileDir(root, profile.profileId), { recursive: true });
  atomicWrite(profileFile(root, profile.profileId), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...profile }, null, 2)}\n`);
  const index = loadIndex(root);
  const next = index.profiles.filter((row) => row.profileId !== profile.profileId);
  next.unshift(toIndexRow(profile));
  index.profiles = next;
  if (profile.knownGood) index.knownGoodProfileId = profile.profileId;
  saveIndex(root, index);
  return profile;
}

function getProfile(root, profileId) {
  try {
    return JSON.parse(fs.readFileSync(profileFile(root, profileId), "utf8"));
  } catch {
    return null;
  }
}

function deleteProfile(root, profileId) {
  try {
    fs.rmSync(profileDir(root, profileId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const index = loadIndex(root);
  index.profiles = index.profiles.filter((row) => row.profileId !== profileId);
  if (index.activeProfileId === profileId) index.activeProfileId = index.profiles[0] ? index.profiles[0].profileId : null;
  if (index.knownGoodProfileId === profileId) index.knownGoodProfileId = null;
  saveIndex(root, index);
}

function listProfiles(root) {
  return loadIndex(root).profiles.map((row) => getProfile(root, row.profileId)).filter(Boolean);
}

module.exports = {
  indexPath,
  profileDir,
  profileFile,
  configBlobRoot,
  loadIndex,
  saveIndex,
  writeProfile,
  getProfile,
  deleteProfile,
  listProfiles,
  emptyIndex,
};
