const fs = require("fs");
const path = require("path");

const KIND_LABELS = {
  lspdfr: "LSPDFR plugin",
  rage: "Rage Plugin Hook",
  vehicle: "Cars",
  map: "Buildings / maps",
  audio: "Sound pack",
  uniform: "Uniforms",
  script: "Script / ASI",
  els: "ELS",
  gameconfig: "Gameconfig / heap",
  oiv: "OpenIV package",
  lml: "Lenny's Mod Loader",
};

const GAME_PREFIX =
  /^(plugins|lspdfr|update|x64|els|scripts|mods|lml|common|dlcpacks)([\\/]|$)/i;

const RPH_ROOT_DLLS = new Set([
  "ddsconvert.dll",
  "discord-rpc.dll",
  "discordrpcnet.dll",
  "easyhook.dll",
  "easyhook64.dll",
  "easyload64.dll",
  "fw1fontwrapper.dll",
  "gwen.dll",
  "gwen.unittest.dll",
  "lms.common.dll",
  "lms.portableexecutable.dll",
  "mono.cecil.dll",
  "mono.cecil.mdb.dll",
  "mono.cecil.pdb.dll",
  "mono.cecil.rocks.dll",
  "slimdx.dll",
  "system.valuetuple.dll",
  "xinput1_4.dll",
  "microsoft.expression.drawing.dll",
  "microsoft.visualstudio.qualitytools.unittestframework.dll",
]);

const JUNK_NAME =
  /^(readme|license|changelog|credits|donate|how\s*to|install(?:ation)?\s*instructions|desktop\.ini|thumbs\.db)/i;

function norm(rel) {
  return String(rel || "").replace(/\//g, "\\");
}

function lower(rel) {
  return norm(rel).toLowerCase();
}

function baseName(rel) {
  return path.basename(rel);
}

function parentName(rel) {
  const dir = path.dirname(norm(rel));
  if (!dir || dir === ".") return "";
  return path.basename(dir);
}

function isJunk(rel) {
  const n = lower(rel);
  const parts = n.split(/[\\/]/);
  if (parts.some((part) => part === "__macosx" || part === ".ds_store")) return true;
  if (parts.some((part) => /^(screenshots|preview|previews|images)$/.test(part))) return true;
  if (GAME_PREFIX.test(n)) return false;
  const file = parts[parts.length - 1];
  if (JUNK_NAME.test(file)) return true;
  if (/^defaultskin\.png$|^cursor_.*\.png$/i.test(file)) return false;
  if (/\.(txt|md|rtf|html|url|jpg|jpeg|png|webp|gif|pdf|doc|docx)$/i.test(file)) return true;
  return false;
}

function alreadyPlaced(rel) {
  return GAME_PREFIX.test(lower(rel));
}

function scoreKinds(files) {
  const scores = {
    lspdfr: 0,
    rage: 0,
    vehicle: 0,
    map: 0,
    audio: 0,
    uniform: 0,
    script: 0,
    els: 0,
    gameconfig: 0,
    oiv: 0,
    lml: 0,
  };

  for (const file of files) {
    const n = lower(file);
    const fileName = baseName(n);

    if (n.endsWith(".oiv") || fileName === "assembly.xml") scores.oiv += 8;
    if (fileName === "install.xml" || n.startsWith("lml\\")) scores.lml += 8;
    if (fileName === "ragepluginhook.exe" || fileName === "ragepluginhook.ini") scores.rage += 10;
    if (n.includes("plugins\\lspdfr") || fileName === "lspdfr.dll" || fileName === "lspd first response.dll") {
      scores.lspdfr += 10;
    }
    if (n.includes("plugins\\") && n.endsWith(".dll")) scores.lspdfr += 3;
    if (n.startsWith("els\\") || /vcf|els\.asi|advancedhook/i.test(n)) scores.els += 6;
    const lspdfrTree = n.startsWith("lspdfr\\") || n.startsWith("plugins\\") || fileName === "ragepluginhook.exe";
    if (
      /vehicles\.meta|handling\.meta|carcols|carvariations|vehiclelayouts|vehicles\.rpf/.test(n) ||
      /\.yft$/i.test(fileName)
    ) {
      scores.vehicle += 4;
    }
    if (!lspdfrTree && /police|sheriff|ambulance|firetruk|suv|cruiser|interceptor/.test(n)) {
      scores.vehicle += 1;
    }
    if (/\.(ymap|ybn|ytyp)$/i.test(fileName) || /_manifest|mlo|ymap/.test(n)) {
      scores.map += 4;
    }
    if (!lspdfrTree && /station|building|map|interior|mlo/.test(n)) scores.map += 1;
    if (/\.(awc|rel)$/i.test(fileName) || /audio\\sfx|nametable|resident\.rpf|siren/.test(n)) {
      scores.audio += 6;
    }
    if (/eup|wardrobe\.ini|mp_m_freemode|mp_f_freemode|uniform|clothes/.test(n) || /\.ydd$/i.test(fileName)) {
      scores.uniform += 5;
    }
    if (n.endsWith(".asi") || n.startsWith("scripts\\")) scores.script += 5;
    if (/gameconfig\.xml|heapadjuster|packfilelimitadjuster/.test(n)) scores.gameconfig += 8;
    if (fileName === "dlc.rpf") {
      const pack = parentName(n);
      if (/car|veh|police|sheriff|pack|addon/.test(pack)) scores.vehicle += 5;
      else if (/map|mlo|interior|build|station/.test(pack)) scores.map += 5;
      else if (/audio|sound|siren/.test(pack)) scores.audio += 5;
      else if (/eup|cloth|uniform/.test(pack)) scores.uniform += 5;
      else scores.vehicle += 2;
    }
  }

  const kinds = Object.entries(scores)
    .filter(([, value]) => value >= 4)
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);

  return { kinds: kinds.length ? kinds : ["unknown"], scores };
}

function packNameFrom(rel, archiveName) {
  const parent = parentName(rel);
  if (parent && !/^(install|files|common|content|grand theft auto.*|gta.*|mods|update|x64|dlcpacks)$/i.test(parent)) {
    return parent.replace(/[^a-z0-9_\-]+/gi, "").slice(0, 40) || slugPack(archiveName);
  }
  return slugPack(archiveName);
}

function slugPack(name) {
  return String(name)
    .toLowerCase()
    .replace(/\.(zip|rar|7z|oiv)$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32) || "addonpack";
}

function looksLikeElsXml(rel, textHint) {
  const n = lower(rel);
  if (n.startsWith("els\\") || n.includes("\\els\\")) return true;
  if (!n.endsWith(".xml")) return false;
  if (/vcf|siren|extra/i.test(n)) return true;
  return /<vcf|isels|wrnl|prm|sec/i.test(textHint || "");
}

function parseOivAdds(xml, archivePrefix) {
  const copies = [];
  const addRe = /<add\b([^>]*)>([\s\S]*?)<\/add>/gi;
  let match;
  while ((match = addRe.exec(xml))) {
    const attrs = match[1] || "";
    const inner = String(match[2] || "").trim();
    const source = (attrs.match(/\bsource="([^"]+)"/i) || [])[1] || inner;
    const target = (attrs.match(/\b(?:destination|target|path)="([^"]+)"/i) || [])[1] || inner;
    if (!source || !target) continue;
    const dest = archivePrefix ? path.join(archivePrefix, target) : target;
    copies.push({
      fromHint: source.replace(/\//g, "\\"),
      to: dest.replace(/\//g, "\\"),
    });
  }
  return copies;
}

function parseAssemblyXml(xml) {
  const copies = [];
  const archiveRe = /<archive\b([^>]*)>([\s\S]*?)<\/archive>/gi;
  let match;
  const consumed = [];
  while ((match = archiveRe.exec(xml))) {
    consumed.push(match[0]);
    const attrs = match[1] || "";
    const rpfPath = ((attrs.match(/\bpath="([^"]+)"/i) || [])[1] || "").replace(/\//g, "\\");
    const prefix = rpfPath ? path.join("mods", rpfPath) : "mods";
    copies.push(...parseOivAdds(match[2], prefix));
  }

  let leftover = xml;
  for (const block of consumed) leftover = leftover.replace(block, "");
  copies.push(...parseOivAdds(leftover, ""));
  return copies;
}

function resolveFromHint(files, hint) {
  const want = lower(hint);
  const exact = files.find((file) => lower(file) === want || lower(file).endsWith(`\\${want}`));
  if (exact) return exact;
  const base = baseName(want);
  return files.find((file) => lower(baseName(file)) === base) || null;
}

function remapLoose(rel, archiveName, kinds) {
  const n = lower(rel);
  const file = baseName(rel);

  if (alreadyPlaced(rel)) {
    if (n.startsWith("dlcpacks\\")) return path.join("update", "x64", rel);
    return rel;
  }

  if (file.toLowerCase() === "dlc.rpf") {
    const pack = packNameFrom(rel, archiveName);
    return path.join("update", "x64", "dlcpacks", pack, "dlc.rpf");
  }

  if (file.toLowerCase() === "gameconfig.xml") {
    return path.join("mods", "update", "update.rpf", "common", "data", "gameconfig.xml");
  }

  if (file.toLowerCase() === "dlclist.xml") {
    return path.join("mods", "update", "update.rpf", "common", "data", "dlclist.xml");
  }

  if (file.toLowerCase() === "wardrobe.ini") {
    return path.join("lspdfr", "data", "wardrobe.ini");
  }

  if (file.toLowerCase() === "install.xml") {
    return path.join("lml", slugPack(archiveName), "install.xml");
  }

  if (looksLikeElsXml(rel)) {
    return path.join("ELS", file);
  }

  if (/\.asi$/i.test(file) || /^(dinput8|scripthookv|scripthookvdotnet)\./i.test(file)) {
    return file;
  }

  if (/\.dll$/i.test(file)) {
    if (/ragepluginhook/i.test(file) || RPH_ROOT_DLLS.has(file.toLowerCase())) return file;
    if (/lspd first response/i.test(file)) return path.join("plugins", file);
    const atRoot = !/[\\/]/.test(norm(rel));
    if (atRoot && kinds.includes("rage")) return file;
    if (kinds.includes("lspdfr") || /lspdfr|callout|stoptheped|ultimatebackup|grammarpolice/i.test(file)) {
      return path.join("plugins", "LSPDFR", file);
    }
    if (kinds.includes("script")) return path.join("scripts", file);
    return atRoot ? file : path.join("plugins", file);
  }

  if (/^defaultskin\.png$|^cursor_.*\.png$/i.test(file)) return file;

  if (n.endsWith(".ini") && kinds.includes("lspdfr")) {
    return path.join("plugins", "LSPDFR", file);
  }

  if (/\.(ymap|ybn|ytyp|ydr)$/i.test(file)) {
    return path.join("lml", slugPack(archiveName), rel);
  }

  if (/vehicles\.meta|handling\.meta|carcols|carvariations|vehiclelayouts/i.test(file)) {
    return path.join("lml", slugPack(archiveName), "data", file);
  }

  if (kinds.includes("uniform") && /\.(ydd|ytd)$/i.test(file)) {
    return path.join("mods", "update", "x64", "dlcpacks", slugPack(archiveName), rel);
  }

  if (kinds.includes("audio") && /\.(awc|rel)$/i.test(file)) {
    return path.join("x64", "audio", "sfx", file);
  }

  return rel;
}

function collectDlcPacks(copies) {
  const packs = new Set();
  for (const copy of copies) {
    const match = lower(copy.to).match(/(?:^|[\\/])dlcpacks[\\/]([^\\/]+)[\\/]dlc\.rpf$/);
    if (match) packs.add(match[1]);
  }
  return [...packs];
}

function notesFor(kinds, copies, dlcPacks) {
  const notes = [];
  if (kinds.includes("vehicle")) {
    notes.push("Cars install as addon DLC or replacement files in the LSPDFR folder. New packs are registered in dlclist.xml when that file already exists.");
  }
  if (kinds.includes("map")) {
    notes.push("Buildings and map files go into DLC packs or the OpenIV mods folder. Interiors (MLO) need ScriptHookV and usually OpenIV.asi.");
  }
  if (kinds.includes("audio")) {
    notes.push("Sound packs land in audio/DLC folders. Vehicle sirens often also need ELS or a matching car pack.");
  }
  if (kinds.includes("uniform")) {
    notes.push("Uniforms / EUP install into LSPDFR wardrobe data or the OpenIV mods folder. EUP Menu is required to wear most addon clothes.");
  }
  if (kinds.includes("oiv")) {
    notes.push("OpenIV packages are unpacked using assembly.xml and copied into the mods folder layout.");
  }
  if (kinds.includes("lml")) {
    notes.push("Lenny's Mod Loader packages are copied into lml\\. Install LML in this folder if it is not already present.");
  }
  if (dlcPacks.length) {
    notes.push(`Addon packs to register: ${dlcPacks.join(", ")}.`);
  }
  if (copies.some((copy) => lower(copy.to).startsWith("mods\\"))) {
    notes.push("Some files target the mods folder. OpenIV.asi must be installed or those replacements will not load.");
  }
  return notes;
}

function warningsForKinds(kinds, files, copies, dlcPacks) {
  const warnings = [];
  const lowerFiles = files.map(lower);

  if (lowerFiles.some((file) => file.endsWith(".oiv")) && !copies.length) {
    warnings.push("The OpenIV package could not be decoded. Files will be copied as they were packed.");
  }
  if (kinds.includes("map") || kinds.includes("vehicle") || kinds.includes("uniform")) {
    if (!lowerFiles.some((file) => file.endsWith("openiv.asi") || file.includes("lml\\"))) {
      warnings.push("This pack may need OpenIV.asi or Lenny's Mod Loader already in the LSPDFR folder.");
    }
  }
  if (kinds.includes("vehicle") && !lowerFiles.some((file) => /gameconfig|heapadjuster/i.test(file))) {
    warnings.push("Many addon cars need a raised gameconfig and HeapAdjuster. Run a function test after install.");
  }
  if (kinds.includes("rage")) {
    warnings.push("Rage Plugin Hook is in this archive. Keep BattlEye off for Story Mode.");
  }
  if (dlcPacks.length) {
    warnings.push("Addon DLC only loads after dlclist.xml lists the pack. The function test will flag missing entries.");
  }
  if (!copies.length) {
    warnings.push("No standard GTA folders were detected. Files will be copied relative to the archive layout.");
  }
  if (
    copies.some(
      (copy) =>
        !GAME_PREFIX.test(lower(copy.to)) &&
        !/\.(asi|dll|exe|ini|txt)$/i.test(copy.to)
    )
  ) {
    warnings.push(
      "Some files are not in a standard GTA folder. They may need LML or OpenIV before buildings, cars, or clothes appear."
    );
  }
  return warnings;
}

function buildPlanFiles({ files, archiveName, payloadRoot, assemblyCopies }) {
  const usable = files.filter((file) => !isJunk(file));
  const { kinds } = scoreKinds(usable.length ? usable : files);
  const copies = [];

  if (assemblyCopies && assemblyCopies.length) {
    for (const item of assemblyCopies) {
      const from = resolveFromHint(files, item.fromHint);
      if (!from) continue;
      copies.push({ from, to: item.to.replace(/\//g, "\\") });
    }
  }

  if (!copies.length) {
    for (const file of usable) {
      copies.push({
        from: file,
        to: remapLoose(file, archiveName, kinds).replace(/\//g, "\\"),
      });
    }
  }

  const seen = new Set();
  const unique = [];
  for (const copy of copies) {
    const key = `${copy.from}=>${copy.to}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(copy);
  }

  const dlcPacks = collectDlcPacks(unique);
  const destinations = topDestinations(unique);
  return {
    kinds,
    kindLabels: kinds.filter((kind) => KIND_LABELS[kind]).map((kind) => KIND_LABELS[kind]),
    copies: unique,
    dlcPacks,
    destinations,
    notes: notesFor(kinds, unique, dlcPacks),
    warnings: warningsForKinds(kinds, files, unique, dlcPacks),
    payloadRoot,
  };
}

function topDestinations(copies) {
  const counts = new Map();
  for (const copy of copies) {
    const parts = copy.to.split(/[\\/]/);
    const top = parts.length > 1 ? parts.slice(0, 2).join("\\") : parts[0];
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
}

function findAssembly(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name.toLowerCase() !== "__macosx") stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase() === "assembly.xml") return full;
    }
  }
  return null;
}

function readAssemblyCopies(root) {
  const assembly = findAssembly(root);
  if (!assembly) return [];
  try {
    const xml = fs.readFileSync(assembly, "utf8");
    return parseAssemblyXml(xml);
  } catch {
    return [];
  }
}

module.exports = {
  KIND_LABELS,
  RPH_ROOT_DLLS,
  isJunk,
  scoreKinds,
  buildPlanFiles,
  readAssemblyCopies,
  packNameFrom,
  slugPack,
};
