const { normalizeDutyDest } = require("./gameTreeNormalize");

function destOf(file) {
  return typeof file === "string" ? file : file.destination || file.dest || "";
}

function baseName(rel) {
  return String(rel || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase();
}

function isPluginDest(rel) {
  const norm = normalizeDutyDest(rel);
  return /^plugins\/(?:lspdfr\/)?[^/]+\.(dll|asi)$/i.test(norm);
}

function ownedRuntimeFiles(mod) {
  const out = [];
  const seen = new Set();
  for (const file of mod.files || []) {
    const dest = destOf(file);
    const name = baseName(dest);
    if (!name || seen.has(name) || /scripthookv/i.test(name)) continue;
    if (!isPluginDest(dest) && !/\.asi$/i.test(name)) continue;
    seen.add(name);
    out.push({
      file: name,
      dest: normalizeDutyDest(dest),
      hash: file && file.hash ? String(file.hash) : "",
      primary: out.length === 0,
    });
  }
  return out;
}

function ownershipMap(mods = []) {
  const byFile = new Map();
  for (const mod of mods || []) {
    const installId = mod.id || mod.installId;
    if (!installId) continue;
    for (const item of ownedRuntimeFiles(mod)) {
      const list = byFile.get(item.file) || [];
      list.push({
        installId,
        canonicalModId: mod.canonicalModId || null,
        name: mod.name || "",
        dest: item.dest,
        hash: item.hash,
        primary: item.primary,
      });
      byFile.set(item.file, list);
    }
  }
  return byFile;
}

function ownersOf(map, fileName) {
  return (map && map.get(String(fileName || "").toLowerCase())) || [];
}

function fingerprint(mod = {}) {
  const files = ownedRuntimeFiles(mod);
  const hash = (mod.sourceArchiveHash || (files[0] && files[0].hash) || "").trim();
  return {
    installId: mod.id || mod.installId || "",
    version: String(mod.version || "UNKNOWN"),
    hash,
  };
}

module.exports = {
  destOf,
  baseName,
  isPluginDest,
  ownedRuntimeFiles,
  ownershipMap,
  ownersOf,
  fingerprint,
};
