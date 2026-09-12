const fs = require("fs");
const path = require("path");

// Rule-based classifier + destination mapper for Smart Install v1.
// Reads src/rules/installRules.json and, for each usable file, picks the first
// matching rule to assign a category, a destination inside the Duty folder,
// and a per-file confidence. Also aggregates an overall category + confidence.

const DEFAULT_RULES = path.join(__dirname, "..", "rules", "installRules.json");

let cachedRules = null;

function loadRules(rulesPath = DEFAULT_RULES) {
  if (rulesPath === DEFAULT_RULES && cachedRules) return cachedRules;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(rulesPath, "utf8"));
  } catch {
    data = { rules: [], fallback: { category: "UNKNOWN", confidence: 0.2, dest: { keep: "path" } }, confidenceBands: [] };
  }
  if (rulesPath === DEFAULT_RULES) cachedRules = data;
  return data;
}

function normSlash(rel) {
  return String(rel || "").replace(/\\/g, "/");
}

function lower(rel) {
  return normSlash(rel).toLowerCase();
}

function matchesRule(rule, file, context) {
  const m = rule.match || {};
  const relLower = lower(file.rel);
  const base = file.base.toLowerCase();

  if (m.ext && !m.ext.map((e) => e.toLowerCase()).includes(file.ext)) return false;
  if (m.atRoot && normSlash(file.rel).includes("/")) return false;
  if (m.pathPrefix && !m.pathPrefix.some((p) => relLower.startsWith(p.toLowerCase()))) return false;
  if (m.pathIncludes && !m.pathIncludes.some((p) => relLower.includes(p.toLowerCase()))) return false;
  if (m.nameEquals && !m.nameEquals.map((n) => n.toLowerCase()).includes(base)) return false;
  if (m.nameMatches && !m.nameMatches.some((n) => base.includes(n.toLowerCase()))) return false;
  if (m.hasSibling && !m.hasSibling.some((n) => context.siblingBaseNames.has(n.toLowerCase()))) return false;
  return true;
}

function resolveDest(rule, file) {
  const dest = rule.dest || { keep: "path" };
  const rel = normSlash(file.rel);
  const parts = rel.split("/");

  if (dest.keep === "path") return rel;

  if (dest.keep === "fromSegment" && dest.segment) {
    const idx = parts.findIndex((p) => p.toLowerCase() === dest.segment.toLowerCase());
    if (idx >= 0) return parts.slice(idx).join("/");
    // Segment not found: fall back to placing under the segment folder by name.
    return [dest.segment, file.base].join("/");
  }

  // keep === "name" (default when a dir is provided)
  const dir = dest.dir || "";
  return dir ? `${dir}/${file.base}` : file.base;
}

function bandFor(confidence, bands) {
  const sorted = [...(bands || [])].sort((a, b) => (b.min || 0) - (a.min || 0));
  for (const band of sorted) {
    if (confidence >= (band.min || 0)) return band;
  }
  return { mode: "MANUAL", label: "Low confidence" };
}

// Classifies a scan result (from modScanner.scan).
// Returns:
//   { type, confidence, mode, modeLabel, perFile:[{rel,destination,category,confidence,ruleId}],
//     categories:{cat:count}, unknownCount, usableCount }
function classify(scan, rulesPath = DEFAULT_RULES) {
  const rules = loadRules(rulesPath);
  const siblingBaseNames = new Set((scan.usableFiles || []).map((f) => f.base.toLowerCase()));
  const context = { siblingBaseNames };

  const perFile = [];
  const categories = {};
  let confidenceSum = 0;
  let unknownCount = 0;

  for (const file of scan.usableFiles || []) {
    let matched = null;
    for (const rule of rules.rules || []) {
      if (matchesRule(rule, file, context)) {
        matched = rule;
        break;
      }
    }
    const rule = matched || {
      id: "fallback",
      category: (rules.fallback && rules.fallback.category) || "UNKNOWN",
      confidence: (rules.fallback && rules.fallback.confidence) || 0.2,
      dest: (rules.fallback && rules.fallback.dest) || { keep: "path" },
    };

    const destination = resolveDest(rule, file);
    const category = rule.category;
    const confidence = typeof rule.confidence === "number" ? rule.confidence : 0.2;

    if (category === "UNKNOWN") unknownCount += 1;
    categories[category] = (categories[category] || 0) + 1;
    confidenceSum += confidence;

    perFile.push({
      rel: normSlash(file.rel),
      destination,
      category,
      confidence,
      ruleId: rule.id,
      size: file.size,
    });
  }

  const usableCount = perFile.length;
  const confidence = usableCount ? Number((confidenceSum / usableCount).toFixed(3)) : 0;

  // Primary type = category with the greatest summed confidence, ignoring
  // pure structural/unknown buckets when a real category exists.
  const weighted = {};
  for (const item of perFile) {
    weighted[item.category] = (weighted[item.category] || 0) + item.confidence;
  }
  const meaningful = Object.entries(weighted).filter(([cat]) => cat !== "UNKNOWN");
  const ranked = (meaningful.length ? meaningful : Object.entries(weighted)).sort((a, b) => b[1] - a[1]);
  const type = ranked.length ? ranked[0][0] : "UNKNOWN";

  const band = bandFor(confidence, rules.confidenceBands);

  return {
    type,
    confidence,
    mode: band.mode,
    modeLabel: band.label,
    perFile,
    categories,
    unknownCount,
    usableCount,
  };
}

module.exports = { classify, loadRules, resolveDest, DEFAULT_RULES };
