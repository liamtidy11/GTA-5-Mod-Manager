function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineMatches(line, signal) {
  const text = String(line || "");
  const needle = String((signal && signal.contains) || "");
  if (!needle) return false;
  if (signal.match === "exact") return text.trim() === needle;
  return text.toLowerCase().includes(needle.toLowerCase());
}

function scanSignals(text, signals = []) {
  const lines = String(text || "").split(/\r?\n/);
  for (const signal of signals || []) {
    for (const line of lines) {
      if (lineMatches(line, signal)) {
        return { type: signal.type || "USER_LINE", evidence: line.trim().slice(0, 240), signal };
      }
    }
  }
  return null;
}

function tokenOverlap(ident, phrase) {
  const packed = compact(phrase);
  if (packed.length < 6) return false;
  for (const token of ident.tokens || []) {
    if (token.length >= 6 && (packed.includes(token) || token.includes(packed))) return true;
    const n = Math.min(10, token.length, packed.length);
    if (n >= 8 && token.slice(0, n) === packed.slice(0, n)) return true;
  }
  return false;
}

function lineNameTokens(line) {
  const parts = String(line || "")
    .split(/[^A-Za-z0-9]+/)
    .map(compact)
    .filter(Boolean);
  const tokens = new Set(parts);
  for (let i = 0; i < parts.length - 1; i += 1) {
    tokens.add(parts[i] + parts[i + 1]);
  }
  return tokens;
}

function stripLogPrefix(line) {
  return String(line || "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/^(?:LSPD First Response|Rage Plugin Hook|RAGE Plugin Hook):\s*/i, "");
}

function isLspdfrCoreOnly(ident) {
  const files = (ident && ident.observables) || [];
  return files.length === 1 && String(files[0].file || "").toLowerCase() === "lspd first response.dll";
}

function ownedHit(ident, line, { strict = false } = {}) {
  const blob = stripLogPrefix(line);
  const tokens = lineNameTokens(blob);
  for (const item of ident.observables || []) {
    if (new RegExp(`\\b${escapeRegex(item.file)}\\b`, "i").test(blob)) return item;
    if (new RegExp(`\\b${escapeRegex(item.stem)}\\b`, "i").test(blob)) return item;
    const stem = compact(item.stem);
    if (strict && stem.length >= 6 && tokens.has(stem)) return item;
  }
  if (strict) return null;
  if (tokenOverlap(ident, blob)) return { file: "", stem: ident.tokens[0] || "", kind: "PLUGIN" };
  return null;
}

const POSITIVE = [
  { type: "RPH_PLUGIN_LOADED", test: /Loading plugin from path:.*([^\\/]+\.(?:dll|asi))/i },
  { type: "RPH_PLUGIN_LOADED", test: /Plugin\s+"([^"]+\.(?:dll|asi))"\s+was loaded/i },
  { type: "RPH_PLUGIN_LOADED", test: /Loaded plugin[:\s]+([^\\/]+\.(?:dll|asi))/i },
  { type: "LSPDFR_PLUGIN_LOADED", test: /Creating plugin:\s*([A-Za-z][A-Za-z0-9._]*)/i },
  { type: "PLUGIN_INITIALIZED", test: /([A-Za-z][A-Za-z0-9._]{3,})\s+(?:initialized|initialised)\s+successfully/i },
  { type: "PLUGIN_INITIALIZED", test: /([A-Za-z][A-Za-z0-9._]{3,}).{0,40}plugin initialized/i },
  { type: "PLUGIN_INITIALIZED", test: /([A-Za-z][A-Za-z0-9._-]{3,}).{0,60}(?:init finished|initialization complete)/i },
  { type: "CALLOUT_REGISTERED", test: /(?:Registered|Registering)\s+(\d+)\s+callouts?/i },
  { type: "CALLOUT_REGISTERED", test: /(\d+)\s+callouts?\s+registered/i },
  { type: "SERVICE_STARTED", test: /([A-Za-z][A-Za-z0-9]{3,})Service\s+Started/i },
  { type: "FRAMEWORK_LOADED", test: /([A-Za-z0-9._-]+\.(?:dll|asi)):\s*([A-Za-z][A-Za-z0-9._]*)/i },
  { type: "MANAGED_DLL_USED", test: /Loaded(?:\s+asi)?[:\s]+([^\\/]+\.(?:dll|asi))/i },
  { type: "MANAGED_DLL_USED", test: /Loading ASI[:\s]+([^\\/]+\.(?:dll|asi))/i },
];

const FAILURES = [
  { type: "PLUGIN_LOAD_FAILED", test: /Failed to load plugin[:\s]+([^\\/]+\.(?:dll|asi))/i },
  { type: "PLUGIN_EXCEPTION", test: /([^\\/]+\.(?:dll|asi)).{0,120}(?:threw an exception|unhandled exception|fatal error)/i },
  { type: "PLUGIN_EXCEPTION", test: /(?:unhandled exception|exception thrown|filenotfoundexception).{0,120}([^\\/]+\.(?:dll|asi))/i },
  { type: "INITIALIZATION_FAILED", test: /([A-Za-z][A-Za-z0-9._]{3,}).{0,80}(?:failed to initialize|initialization failed)/i },
  { type: "DEPENDENCY_LOAD_FAILED", test: /([A-Za-z][A-Za-z0-9._]{3,})\s+dependency\s+([^\\/]+\.(?:dll|asi))\s+is not available/i },
  { type: "PLUGIN_LOAD_FAILED", test: /([A-Za-z][A-Za-z0-9 ._-]{3,})\s+failed to load\b/i },
  { type: "DEPENDENCY_LOAD_FAILED", test: /(?:Could not load file or assembly|Could not load)[:\s]+['"]?([^'"\s]+\.(?:dll|asi))/i },
  { type: "TIMEOUT", test: /(?:plugin timeout|timed out).{0,80}([^\\/]+\.(?:dll|asi)|[A-Za-z][A-Za-z0-9._]{3,})/i },
  { type: "SERVICE_START_FAILED", test: /([A-Za-z][A-Za-z0-9]{3,})Service\s+(?:failed|could not start)/i },
  { type: "DLL_NOT_FOUND", test: /(?:FileNotFoundException|Could not find file).{0,80}([^\\/]+\.(?:dll|asi))/i },
  { type: "PLUGIN_EXCEPTION", test: /TERMINATING\s+([A-Za-z0-9._-]+)/i },
];

function ownershipHaystack(pattern, hit, line) {
  const captured = hit[1] || "";
  if (pattern.type === "DEPENDENCY_LOAD_FAILED" && captured && !/\.(dll|asi)$/i.test(captured)) {
    return captured;
  }
  return `${stripLogPrefix(line)} ${captured}`.trim();
}

function isInformationalNoise(line) {
  const text = String(line || "");
  if (/Cannot create an abstract class/i.test(text) && /IPT\.Common/i.test(text)) return true;
  if (/Address mismatch:/i.test(text)) return true;
  if (/\[d3d12\]/i.test(text) && !/(?:failed|fatal|crash|device)/i.test(text)) return true;
  if (/specified twice/i.test(text)) return true;
  if (/Failed to parse\s+as chance/i.test(text)) return true;
  if (/GetOutfitVariation:\s*Failed to find outfit/i.test(text)) return true;
  if (/attempted to start callout\s+.+\s+but nothing happened/i.test(text)) return true;
  if (/NotImplementedException/i.test(text) && /BackupManager/i.test(text)) return true;
  return false;
}

function matchOwnedPattern(text, ident, patterns, ownedOnly) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    if (isInformationalNoise(line)) continue;
    for (const pattern of patterns) {
      const hit = line.match(pattern.test);
      if (!hit) continue;
      const captured = hit[1] || "";
      const haystack = ownershipHaystack(pattern, hit, line);
      if (ownedOnly && !ownedHit(ident, haystack, { strict: true })) continue;
      if (!ownedOnly && !ownedHit(ident, haystack) && !tokenOverlap(ident, captured)) continue;
      return { type: pattern.type, evidence: line.trim().slice(0, 240), captured };
    }
  }
  return null;
}

function matchPositiveGeneric(text, ident) {
  return matchOwnedPattern(text, ident, POSITIVE, false);
}

function matchFailureGeneric(text, ident) {
  const hit = matchOwnedPattern(text, ident, FAILURES, true);
  if (hit) {
    if (isLspdfrCoreOnly(ident) && !/lspd first response\.dll/i.test(`${hit.captured || ""} ${hit.evidence || ""}`)) {
      return null;
    }
    return hit;
  }
  for (const item of ident.observables || []) {
    const blob = String(text || "");
    if (new RegExp(`TERMINATING\\s+${escapeRegex(item.stem)}\\b`, "i").test(blob)) {
      return { type: "PLUGIN_EXCEPTION", evidence: `The session terminated ${item.stem}.`, captured: item.stem };
    }
  }
  for (const abbrev of ident.abbrevs || []) {
    if (new RegExp(`TERMINATING\\s+${escapeRegex(abbrev)}\\b`, "i").test(blobSafe(text))) {
      return { type: "PLUGIN_EXCEPTION", evidence: `The session terminated ${abbrev}.`, captured: abbrev };
    }
  }
  return null;
}

function blobSafe(text) {
  return String(text || "");
}

function distinctiveLines(text, ident, { limit = 8 } = {}) {
  const noise = /rage plugin hook started|unloading plugins|normal shutdown|plugin hook is shutting down|loading plugin from path:.*lspd first response/i;
  const out = [];
  const seen = new Set();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]+\]\s*/, "").trim();
    if (line.length < 16 || line.length > 200 || noise.test(line)) continue;
    if (!ownedHit(ident, line) && !tokenOverlap(ident, line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = {
  lineMatches,
  scanSignals,
  tokenOverlap,
  stripLogPrefix,
  ownedHit,
  matchPositiveGeneric,
  matchFailureGeneric,
  distinctiveLines,
  isInformationalNoise,
};
