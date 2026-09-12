const fs = require("fs");
const path = require("path");
const { exists } = require("./paths");

// Drop-time dependency + compatibility checks. Read-only. Two techniques:
//   1. .NET assemblies embed the names of assemblies they reference, so we
//      byte-scan plugin DLLs for known framework tokens (RAGENativeUI, etc.)
//      and for Script Hook V .NET (parked/incompatible on this Enhanced setup).
//   2. Structural rules based on where files map (mods\, lml\, dlcpacks\).

const DEFAULT_CONFIG = path.join(__dirname, "..", "config", "dependencies.json");
const MAX_SCAN_BYTES = 25 * 1024 * 1024;

let cached = null;

function load(configPath = DEFAULT_CONFIG) {
  if (configPath === DEFAULT_CONFIG && cached) return cached;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    data = { frameworks: [], risky: [], structural: [] };
  }
  const normalized = {
    frameworks: Array.isArray(data.frameworks) ? data.frameworks : [],
    risky: Array.isArray(data.risky) ? data.risky : [],
    structural: Array.isArray(data.structural) ? data.structural : [],
  };
  if (configPath === DEFAULT_CONFIG) cached = normalized;
  return normalized;
}

function lowerBase(rel) {
  return path.basename(String(rel || "").replace(/\\/g, "/")).toLowerCase();
}

function listNamesLower(dir) {
  try {
    return new Set(fs.readdirSync(dir).map((n) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

// Reads a DLL as bytes and reports which tokens appear in it.
function tokensInFile(absPath, tokens) {
  const found = new Set();
  try {
    if (fs.statSync(absPath).size > MAX_SCAN_BYTES) return found;
    const text = fs.readFileSync(absPath).toString("latin1");
    for (const token of tokens) {
      if (text.includes(token)) found.add(token);
    }
  } catch {
    /* unreadable file: skip */
  }
  return found;
}

// check({ files, payloadRoot, dutyPath, config? })
//   files: preview file plan entries ({ source, destination, action, category })
// Returns { dependencies:[...], compatibility:[...], missingRequired, incompatible }.
function check({ files = [], payloadRoot, dutyPath, config = load() } = {}) {
  const installable = files.filter((f) => f.action === "add" || f.action === "replace");

  // What this pack already provides + what the Duty folder already has.
  const provided = new Set(installable.map((f) => lowerBase(f.destination)));
  if (dutyPath) {
    for (const name of listNamesLower(dutyPath)) provided.add(name);
    for (const name of listNamesLower(path.join(dutyPath, "plugins"))) provided.add(name);
    for (const name of listNamesLower(path.join(dutyPath, "plugins", "LSPDFR"))) provided.add(name);
  }

  const frameworkTokens = config.frameworks.map((f) => f.token);
  const riskyTokens = config.risky.map((r) => r.token);
  const allTokens = [...frameworkTokens, ...riskyTokens];

  // Scan the pack's DLLs once and union the tokens found.
  const foundTokens = new Set();
  for (const file of installable) {
    if (!/\.dll$/i.test(file.source)) continue;
    if (!payloadRoot) continue;
    const abs = path.join(payloadRoot, file.source.split("/").join(path.sep));
    for (const token of tokensInFile(abs, allTokens)) foundTokens.add(token);
  }

  const dependencies = [];
  let missingRequired = false;

  for (const fw of config.frameworks) {
    if (!foundTokens.has(fw.token)) continue;
    const present = provided.has(fw.file.toLowerCase());
    if (present) {
      dependencies.push({ name: fw.name, file: fw.file, level: fw.level, present: true, note: `${fw.name} is present.` });
    } else {
      missingRequired = missingRequired || fw.level === "required";
      dependencies.push({
        name: fw.name,
        file: fw.file,
        level: fw.level,
        present: false,
        url: fw.url || "",
        note: `A plugin references ${fw.name}, but ${fw.file} was not found in this pack or your LSPDFR folder. ${fw.note || ""}`.trim(),
      });
    }
  }

  const compatibility = [];
  let incompatible = false;

  for (const risk of config.risky) {
    if (!foundTokens.has(risk.token)) continue;
    incompatible = incompatible || risk.level === "incompatible";
    compatibility.push({ level: risk.level, name: risk.name, note: risk.note });
  }

  // Structural checks based on where files map.
  const destsLower = installable.map((f) => String(f.destination).replace(/\\/g, "/").toLowerCase());
  for (const rule of config.structural) {
    const hit =
      rule.when === "destPrefix"
        ? destsLower.some((d) => d.startsWith(rule.value.toLowerCase()))
        : rule.when === "destContains"
          ? destsLower.some((d) => d.includes(rule.value.toLowerCase()))
          : false;
    if (!hit) continue;
    const present = rule.requires
      ? provided.has(rule.requires.toLowerCase()) || (dutyPath && exists(path.join(dutyPath, rule.requires)))
      : false;
    if (present) continue;
    compatibility.push({ level: rule.level || "warning", name: rule.name, note: rule.note });
  }

  return { dependencies, compatibility, missingRequired, incompatible };
}

module.exports = { load, check, DEFAULT_CONFIG };
