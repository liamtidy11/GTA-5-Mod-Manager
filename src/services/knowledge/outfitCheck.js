const fs = require("fs");
const path = require("path");

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function outfitScriptNames(xml) {
  const names = new Set();
  const blocks = String(xml || "").match(/<Outfit\b[\s\S]*?<\/Outfit>/gi) || [];
  for (const block of blocks) {
    const hit = block.match(/<ScriptName>\s*([^<]+)\s*<\/ScriptName>/i);
    if (hit) names.add(hit[1].trim().toLowerCase());
  }
  return names;
}

function referencedOutfits(xml) {
  const names = new Set();
  const re = /\boutfit\s*=\s*"([^"]+)"/gi;
  let match;
  while ((match = re.exec(xml))) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    names.add(raw.split(".")[0].toLowerCase());
  }
  return names;
}

function logMissingOutfits(logText) {
  const names = [];
  const re = /Failed to find outfit\s+([A-Za-z0-9._-]+)/gi;
  let match;
  while ((match = re.exec(logText || ""))) {
    const name = match[1].trim();
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function inspect(dutyPath, logText = "") {
  const outfitsPath = path.join(dutyPath || "", "lspdfr", "data", "outfits.xml");
  const agencyPath = path.join(dutyPath || "", "lspdfr", "data", "agency.xml");
  const defined = outfitScriptNames(readText(outfitsPath));
  const referenced = referencedOutfits(readText(agencyPath));
  const fromLog = logMissingOutfits(logText);
  const missingDefs = [...referenced].filter((name) => !defined.has(name));
  const logMissingUndefined = fromLog.filter((name) => !defined.has(name.toLowerCase()));
  const logMissingDefined = fromLog.filter((name) => defined.has(name.toLowerCase()));
  return {
    defined: [...defined],
    referenced: [...referenced],
    fromLog,
    missingDefs,
    logMissingUndefined,
    logMissingDefined,
  };
}

module.exports = {
  outfitScriptNames,
  referencedOutfits,
  logMissingOutfits,
  inspect,
};
