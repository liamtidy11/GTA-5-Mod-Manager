const fs = require("fs");
const path = require("path");
const { exists } = require("./paths");

const CANDIDATES = [
  ["mods", "update", "update.rpf", "common", "data", "dlclist.xml"],
  ["mods", "update", "update", "common", "data", "dlclist.xml"],
  ["update", "update.rpf", "common", "data", "dlclist.xml"],
];

function findDlclist(sandboxPath) {
  for (const parts of CANDIDATES) {
    const file = path.join(sandboxPath, ...parts);
    if (exists(file)) return file;
  }
  return null;
}

function listedPacks(xml) {
  const packs = new Set();
  const re = /<Item>\s*(?:dlcpacks:|platform:\/dlcPacks\/)\/?([^/<]+)\s*\/?\s*<\/Item>/gi;
  let match;
  while ((match = re.exec(xml))) {
    packs.add(String(match[1]).replace(/\/+$/, "").toLowerCase());
  }
  return packs;
}

function insertItems(xml, packs) {
  const known = listedPacks(xml);
  const missing = packs.filter((pack) => !known.has(pack.toLowerCase()));
  if (!missing.length) return { xml, added: [] };

  const items = missing.map((pack) => `    <Item>dlcpacks:/${pack}/</Item>`).join("\n");
  if (/<\/Paths>/i.test(xml)) {
    return { xml: xml.replace(/<\/Paths>/i, `${items}\n  </Paths>`), added: missing };
  }
  if (/<\/Items>/i.test(xml)) {
    return { xml: xml.replace(/<\/Items>/i, `${items}\n  </Items>`), added: missing };
  }
  return { xml: `${xml.trimEnd()}\n${items}\n`, added: missing };
}

function registerPacks(sandboxPath, packs) {
  const unique = [...new Set((packs || []).map((pack) => String(pack).trim()).filter(Boolean))];
  if (!unique.length) return { ok: false, reason: "No DLC packs to register.", added: [] };

  const file = findDlclist(sandboxPath);
  if (!file) {
    return {
      ok: false,
      reason: "No writable dlclist.xml yet. Install a gameconfig / OpenIV mods-folder pack first so addon cars and maps can be registered.",
      added: [],
    };
  }

  const current = fs.readFileSync(file, "utf8");
  const { xml, added } = insertItems(current, unique);
  if (added.length) fs.writeFileSync(file, xml, "utf8");
  return { ok: true, file, added };
}

function unregisterPacks(sandboxPath, packs) {
  const file = findDlclist(sandboxPath);
  if (!file || !packs?.length) return { ok: true, removed: [] };
  let xml = fs.readFileSync(file, "utf8");
  const removed = [];
  for (const pack of packs) {
    const re = new RegExp(
      `\\s*<Item>\\s*(?:dlcpacks:|platform:\\/dlcPacks\\/)\\/?${escapeReg(pack)}\\/?\\s*<\\/Item>`,
      "gi"
    );
    if (re.test(xml)) {
      xml = xml.replace(re, "");
      removed.push(pack);
    }
  }
  if (removed.length) fs.writeFileSync(file, xml, "utf8");
  return { ok: true, removed };
}

function escapeReg(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extraPacks(sandboxPath, officialPath) {
  const sand = listPackDirs(path.join(sandboxPath, "update", "x64", "dlcpacks"));
  const mods = listPackDirs(path.join(sandboxPath, "mods", "update", "x64", "dlcpacks"));
  const official = new Set(listPackDirs(path.join(officialPath || "", "update", "x64", "dlcpacks")));
  return [...new Set([...sand, ...mods])].filter((pack) => !official.has(pack));
}

function listPackDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name.toLowerCase());
  } catch {
    return [];
  }
}

function unregisteredPacks(sandboxPath, officialPath) {
  const file = findDlclist(sandboxPath);
  const extras = extraPacks(sandboxPath, officialPath);
  if (!file) return { file: null, extras, missing: extras };
  const listed = listedPacks(fs.readFileSync(file, "utf8"));
  return {
    file,
    extras,
    missing: extras.filter((pack) => !listed.has(pack)),
  };
}

module.exports = {
  findDlclist,
  registerPacks,
  unregisterPacks,
  extraPacks,
  unregisteredPacks,
};
