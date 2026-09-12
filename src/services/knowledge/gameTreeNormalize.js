const GAME_TREE_NAMES = /^(gtav main directory|gta v(?: enhanced)?|grand theft auto v(?: enhanced)?)$/i;

const WRAPPER_PREFIX =
  /^(?:[!\-*_~\s.]+)?(?:gtav main directory|gta v(?: enhanced)?|grand theft auto v(?: enhanced)?)\/+/i;

function normSlash(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function cleanedDirName(name) {
  return String(name || "")
    .replace(/^[!\-*_~\s.]+/, "")
    .trim();
}

function isGameTreeDirName(name) {
  return GAME_TREE_NAMES.test(cleanedDirName(name));
}

function stripGameWrapperPrefix(rel) {
  return normSlash(rel).replace(WRAPPER_PREFIX, "");
}

function normalizeDutyDest(rel) {
  return stripGameWrapperPrefix(rel);
}

function destNeedsNormalize(rel) {
  const next = normalizeDutyDest(rel);
  return Boolean(next) && next !== normSlash(rel);
}

module.exports = {
  GAME_TREE_NAMES,
  cleanedDirName,
  isGameTreeDirName,
  stripGameWrapperPrefix,
  normalizeDutyDest,
  destNeedsNormalize,
  normSlash,
};
