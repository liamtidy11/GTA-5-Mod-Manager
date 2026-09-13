const fs = require("fs");
const path = require("path");
const { RPH_ROOT_DLLS } = require("../modtypes");
const { normalizeDutyDest } = require("./gameTreeNormalize");
const evidenceStore = require("./runtimeEvidence");
const dutyLogScan = require("./dutyLogScan");

// Per-mod in-game checks from Duty logs. Works for current installs and any
// future pack — identity comes from that mod's own files/name, not a fixed list.
// Never upgrades built-in catalog compatibility. Never marks ScriptHookV.

const LOG_WINDOW_BYTES = 2 * 1024 * 1024;
const SILENT_MIN_MS = 30000;
const MIN_NAME_TOKEN = 6;

const LIBRARY_DLLS = new Set([
  "ragenativeui.dll",
  "lemonui.dll",
  "lemonui.ragepluginhook.dll",
  "ifruitaddon2.dll",
  "commondataframework.dll",
  "commondatanet.dll",
  "irrklang.net4.dll",
  "irrklang.net.dll",
  "newtonsoft.json.dll",
  "damagetrackerlib.dll",
]);

const SILENT_EXT =
  /\.(ytd|yft|ydr|ydd|ycd|ybn|ymap|ytyp|rpf|awc|rel|gxt2|meta|xml|ini|json|oiv|yld|ypt|ynv)$/i;

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function destList(mod) {
  return (mod.files || [])
    .map((file) => (typeof file === "string" ? file : file.destination || file.dest || ""))
    .filter(Boolean)
    .map((rel) => normalizeDutyDest(rel));
}

function baseName(rel) {
  return String(rel || "")
    .split("/")
    .pop();
}

function isNeverVerifyFile(name) {
  return /scripthookv/i.test(String(name || ""));
}

function isSupportFile(name) {
  const lower = String(name || "").toLowerCase();
  return RPH_ROOT_DLLS.has(lower) || lower === "newtonsoft.json.dll" || lower === "dinput8.dll";
}

function isHookMod(mod) {
  const hay = [mod.canonicalModId, mod.id, mod.name, mod.displayName].filter(Boolean).join(" ").toLowerCase();
  return /(?:^|[\s/_-])(?:rage-plugin-hook|ragepluginhook|rage plugin hook)(?:$|[\s/_-])/.test(` ${hay} `);
}

function neverVerifyMod(mod) {
  if (destList(mod).some((rel) => isNeverVerifyFile(baseName(rel)))) return true;
  const hay = [mod.canonicalModId, mod.id, mod.name].filter(Boolean).join(" ");
  return /scripthookv/i.test(hay);
}

function observablesFromFiles(mod) {
  const items = [];
  const seen = new Set();
  for (const dest of destList(mod)) {
    const file = baseName(dest);
    if (!file || isSupportFile(file) || isNeverVerifyFile(file)) continue;
    const plugin = /^plugins\/(?:lspdfr\/)?[^/]+\.(dll|asi)$/i.test(dest);
    const asi = /^[^/]+\.asi$/i.test(dest) || /^scripts\/[^/]+\.asi$/i.test(dest);
    if (!plugin && !asi) continue;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      file,
      stem: file.replace(/\.(dll|asi)$/i, ""),
      kind: /\.asi$/i.test(file) ? "ASI" : "PLUGIN",
      library: LIBRARY_DLLS.has(key),
    });
  }
  return items;
}

function observablesFromCatalog(mod, catalog) {
  const id = mod.canonicalModId;
  if (!id || !catalog || !Array.isArray(catalog.mods)) return [];
  const entry = catalog.mods.find((row) => row.id === id);
  const names = (entry && entry.recognition && entry.recognition.dllNames) || [];
  return names
    .map((name) => String(name || "").trim())
    .filter((name) => name && !isSupportFile(name) && !isNeverVerifyFile(name))
    .map((file) => ({
      file,
      stem: file.replace(/\.(dll|asi)$/i, ""),
      kind: /\.asi$/i.test(file) ? "ASI" : "PLUGIN",
      library: LIBRARY_DLLS.has(file.toLowerCase()),
    }));
}

function mergeObservables(mod, catalog) {
  const merged = [];
  const seen = new Set();
  for (const item of [...observablesFromFiles(mod), ...observablesFromCatalog(mod, catalog)]) {
    const key = item.file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

function primaryObservables(mod, catalog) {
  const all = mergeObservables(mod, catalog);
  const primary = all.filter((item) => !item.library);
  return primary.length ? primary : all;
}

function pascalAbbrev(stem) {
  const caps = String(stem || "").match(/[A-Z]/g);
  if (!caps || caps.length < 2) return "";
  return caps.join("");
}

function nameTokens(mod, observables) {
  const tokens = new Set();
  for (const item of observables || []) {
    const stem = compact(item.stem);
    if (stem.length >= 4) tokens.add(stem);
  }
  for (const value of [mod.name, mod.displayName, mod.canonicalModId]) {
    const token = compact(value);
    if (token.length >= MIN_NAME_TOKEN) tokens.add(token);
  }
  return [...tokens];
}

function isSilentContent(mod, catalog) {
  if (neverVerifyMod(mod) || isHookMod(mod)) return false;
  if (primaryObservables(mod, catalog).length) return false;
  return destList(mod).some((rel) => SILENT_EXT.test(rel));
}

function identities(mod, catalog) {
  const observables = primaryObservables(mod, catalog);
  return {
    observables,
    tokens: nameTokens(mod, observables),
    abbrevs: observables.map((item) => pascalAbbrev(item.stem)).filter((row) => row.length >= 2),
    silent: isSilentContent(mod, catalog),
    hook: isHookMod(mod),
    skip: neverVerifyMod(mod),
  };
}

function pluginFailed(text, ident) {
  const blob = String(text || "");
  for (const item of ident.observables || []) {
    const file = escapeRegex(item.file);
    const stem = escapeRegex(item.stem);
    if (new RegExp(`Failed to load plugin[:\\s]+${file}`, "i").test(blob)) {
      return `Failed to load ${item.file}.`;
    }
    if (new RegExp(`${file}.{0,100}(?:threw an exception|unhandled exception|fatal error)`, "i").test(blob)) {
      return `${item.file} threw an exception.`;
    }
    if (new RegExp(`(?:unhandled exception|exception thrown|filenotfoundexception).{0,100}${file}`, "i").test(blob)) {
      return `A log exception named ${item.file}.`;
    }
    if (new RegExp(`TERMINATING\\s+${stem}\\b`, "i").test(blob)) {
      return `The session terminated ${item.stem}.`;
    }
  }
  for (const abbrev of ident.abbrevs || []) {
    if (new RegExp(`TERMINATING\\s+${escapeRegex(abbrev)}\\b`, "i").test(blob)) {
      return `The session terminated ${abbrev}.`;
    }
  }
  return "";
}

function creatingPluginHit(text, ident) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const hit = line.match(/Creating plugin:\s*([A-Za-z][A-Za-z0-9._]*)/i);
    if (!hit) continue;
    const typeName = hit[1];
    const compactType = compact(typeName);
    for (const item of ident.observables || []) {
      if (new RegExp(`^${escapeRegex(item.stem)}\\b`, "i").test(typeName)) return `Creating plugin: ${typeName}`;
    }
    for (const token of ident.tokens || []) {
      if (token.length >= MIN_NAME_TOKEN && compactType.includes(token)) return `Creating plugin: ${typeName}`;
    }
  }
  return "";
}

function pluginLoaded(text, ident) {
  const blob = String(text || "");
  const created = creatingPluginHit(blob, ident);
  if (created) return created;
  for (const item of ident.observables || []) {
    const file = escapeRegex(item.file);
    const stem = escapeRegex(item.stem);
    if (item.kind === "ASI") {
      if (new RegExp(`(?:loading asi|loaded(?:\\s+asi)?)[:\\s]+${file}`, "i").test(blob)) {
        return `Loaded ${item.file}.`;
      }
    }
    if (new RegExp(`Loading plugin from path:.*${file}`, "i").test(blob)) {
      return `Loading plugin from path: ${item.file}`;
    }
    if (new RegExp(`Plugin "${file}" was loaded`, "i").test(blob)) {
      return `Plugin ${item.file} was loaded.`;
    }
    if (new RegExp(`${file}:\\s*${stem}\\b`, "i").test(blob)) {
      return `${item.file} was listed as loaded.`;
    }
  }
  return "";
}

function hookLoaded(text) {
  const blob = String(text || "");
  if (/Rage Plugin Hook started/i.test(blob) && /(?:Unloading plugins|Plugin hook is shutting down|Normal shutdown)/i.test(blob)) {
    return "Rage Plugin Hook started and shut down cleanly.";
  }
  return "";
}

function assessLog(mod, text, catalog) {
  const runtimeVerify = require("./runtimeVerify");
  return runtimeVerify.toLegacy(runtimeVerify.evaluate(mod, { logText: text, catalog }));
}

function readBoundedWindow(filePath, maxBytes = LOG_WINDOW_BYTES) {
  return dutyLogScan.readBoundedWindow(filePath, maxBytes);
}

function candidateLogPaths(session, dutyPath) {
  const duty = dutyPath || (session && session.dutyPath) || "";
  return dutyLogScan.collectLogFiles(session, duty).map((file) => file.path);
}

function collectLogFiles(session, dutyPath) {
  const duty = dutyPath || (session && session.dutyPath) || "";
  return dutyLogScan.collectLogFiles(session, duty);
}

function readSessionLogs(session, dutyPath) {
  return dutyLogScan.joinLogFiles(collectLogFiles(session, dutyPath));
}

function enabledInSession(session, installId) {
  const rows = (session && session.mods) || [];
  if (!rows.length) return false;
  return rows.some((mod) => (mod.installId === installId || mod.id === installId) && mod.enabled !== false);
}

function sessionAllowsWorked(session) {
  return Boolean(session && session.result === "CLEAN_EXIT");
}

function recordFromSession({ dataDir, dutyPath = "", session, mods = [], catalog = null, logText = null } = {}) {
  if (!dataDir || !session || !session.sessionId) return { recorded: [], skipped: true };
  const db = evidenceStore.load(dataDir);
  if (evidenceStore.sessionProcessed(db, session.sessionId)) return { recorded: [], skipped: true };

  const logFiles = logText == null ? collectLogFiles(session, dutyPath) : [];
  const text = logText == null ? dutyLogScan.joinLogFiles(logFiles) : String(logText || "");
  const recorded = [];

  for (const mod of mods) {
    const installId = mod.id || mod.installId;
    if (!installId || mod.enabled === false) continue;
    if (!enabledInSession(session, installId)) continue;

    const runtimeVerify = require("./runtimeVerify");
    const print = require("./dllOwnership").fingerprint(mod);
    const sessionMod = (session.mods || []).find((row) => row.installId === installId || row.id === installId);
    if (sessionMod && sessionMod.version && print.version && sessionMod.version !== "UNKNOWN" && print.version !== "UNKNOWN" && sessionMod.version !== print.version) {
      continue;
    }
    const verdict = runtimeVerify.evaluate(mod, { logText: text, logFiles, catalog, dataDir, session, mods, sessionMod });
    const legacy = runtimeVerify.toLegacy(verdict);
    if (legacy.status === "FAILED") {
      const row = evidenceStore.upsertRow(db, {
        installId,
        canonicalModId: mod.canonicalModId || null,
        status: "FAILED",
        kind: legacy.kind,
        sessionId: session.sessionId,
        evidence: legacy.evidence,
        version: print.version,
        hash: print.hash,
        confidence: verdict.confidence,
        ruleTier: verdict.tier,
      });
      evidenceStore.bumpHistory(db, installId, print.version, "FAILED");
      if (row) recorded.push(row);
      continue;
    }
    if (!sessionAllowsWorked(session)) continue;
    if (legacy.status === "LOADED") {
      const row = evidenceStore.upsertRow(db, {
        installId,
        canonicalModId: mod.canonicalModId || null,
        status: "WORKED",
        kind: legacy.kind,
        sessionId: session.sessionId,
        evidence: legacy.evidence || "This install loaded in a local Duty session.",
        version: print.version,
        hash: print.hash,
        confidence: verdict.confidence,
        ruleTier: verdict.tier,
      });
      evidenceStore.bumpHistory(db, installId, print.version, "WORKED");
      if (row) recorded.push(row);
      continue;
    }
    if (legacy.status === "SILENT") {
      const duration = Number(session.durationMs);
      if (Number.isFinite(duration) && duration > 0 && duration < SILENT_MIN_MS) continue;
      const row = evidenceStore.upsertRow(db, {
        installId,
        canonicalModId: mod.canonicalModId || null,
        status: "WORKED",
        kind: "SESSION_PRESENT",
        sessionId: session.sessionId,
        evidence: "This install was enabled during a clean Duty session.",
      });
      if (row) recorded.push(row);
    }
  }

  evidenceStore.markSessionProcessed(db, session.sessionId);
  evidenceStore.save(dataDir, db);
  return { recorded, skipped: false };
}

function adoptFromSessions({ dataDir, dutyPath = "", sessions = [], mods = [], catalog = null } = {}) {
  const rows = [...(sessions || [])].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const recorded = [];
  for (const session of rows) {
    if (!session || !session.sessionId || !session.result) continue;
    const result = recordFromSession({ dataDir, dutyPath, session, mods, catalog });
    recorded.push(...((result && result.recorded) || []));
  }
  return { recorded };
}

function matchingSession(sessions, mod) {
  const print = require("./dllOwnership").fingerprint(mod);
  const installId = print.installId || mod.id || mod.installId;
  if (!installId) return null;
  for (const session of sessions || []) {
    const row = (session.mods || []).find((item) => (item.installId === installId || item.id === installId) && item.enabled !== false);
    if (!row) continue;
    if (row.version && print.version && row.version !== "UNKNOWN" && print.version !== "UNKNOWN" && row.version !== print.version) {
      continue;
    }
    if (row.hash && print.hash && row.hash !== print.hash) continue;
    return session;
  }
  return null;
}

function historyHasOtherVersion(db, mod) {
  const print = require("./dllOwnership").fingerprint(mod);
  const hist = db && db.history && print.installId ? db.history[print.installId] : null;
  if (!hist || !print.version || print.version === "UNKNOWN") return false;
  return Object.keys(hist).some((ver) => ver !== print.version && ver !== "UNKNOWN");
}

function lookupLive(db, mod = {}, dutyPath = "", catalog = null, extras = {}) {
  const stored = evidenceStore.lookup(db, mod);
  const duty = String(dutyPath || "").trim();
  if (duty) {
    const runtimeVerify = require("./runtimeVerify");
    const session = matchingSession(extras.sessions, mod);
    const logFiles = collectLogFiles(session, duty);
    const log = dutyLogScan.joinLogFiles(logFiles);
    if (log) {
      const verdict = runtimeVerify.evaluate(mod, {
        logText: log,
        logFiles,
        catalog,
        dataDir: extras.dataDir,
        mods: extras.mods,
        session,
      });
      const storedRow = (db && db.mods && (db.mods[mod.id || mod.installId] || null)) || null;
      const versionShift =
        storedRow &&
        storedRow.version &&
        mod.version &&
        storedRow.version !== "UNKNOWN" &&
        mod.version !== "UNKNOWN" &&
        storedRow.version !== mod.version;
      const stale = !session && verdict.tier !== "USER_OVERRIDE" && (historyHasOtherVersion(db, mod) || versionShift);
      if (!stale && verdict.status === "FAILED") {
        return {
          status: "FAILED",
          kind: verdict.kind,
          evidence: verdict.evidence,
          source: "LOCAL_VERIFIED_DATA",
          confidence: verdict.confidence,
          ruleTier: verdict.tier,
        };
      }
      if (!stale && verdict.status === "WORKING") {
        return {
          status: "WORKED",
          kind: verdict.kind,
          evidence: verdict.evidence || "This install loaded in a local Duty session.",
          source: "LOCAL_VERIFIED_DATA",
          confidence: verdict.confidence,
          ruleTier: verdict.tier,
        };
      }
    }
  }
  return stored;
}

module.exports = {
  LIBRARY_DLLS,
  identities,
  assessLog,
  readSessionLogs,
  collectLogFiles,
  recordFromSession,
  adoptFromSessions,
  lookupLive,
  loadEvidence: evidenceStore.load,
  lookup: evidenceStore.lookup,
  getEvidence: evidenceStore.getEvidence,
};
