const path = require("path");
const { exists } = require("../paths");
const modHealthV2 = require("../modHealthV2");
const runtimeCompatibility = require("./runtimeCompatibility");
const { diagnoseManagedMod } = require("../orphanDetector");
const conditionFix = require("./conditionFix");
const pluginSupportLayout = require("./pluginSupportLayout");
const calloutInterfaceMdt = require("./calloutInterfaceMdt");
const keybindReader = require("./keybindReader");

function destOf(file) {
  return typeof file === "string" ? file : file.destination || file.dest || "";
}

function normalizeRel(rel) {
  return String(rel || "")
    .replace(/[/\\]+/g, path.sep)
    .replace(/^[/\\]+/, "");
}

function asSmartShape(mod, source) {
  return {
    id: mod.id || mod.installId,
    name: mod.name || mod.archiveName || "Mod",
    enabled: mod.enabled !== false,
    version: mod.version || "UNKNOWN",
    sourceArchiveHash: mod.sourceArchiveHash || "",
    files: (mod.files || []).map((file) =>
      typeof file === "string"
        ? { destination: file }
        : { destination: destOf(file), hash: file.hash || "" }
    ),
    kinds: mod.kinds || [],
    compatibilityStatus: mod.compatibilityStatus || mod.compatibility || (source === "FOLDER" ? "" : "UNKNOWN"),
    dependencySummary: mod.dependencySummary || {},
    manifestStatus: mod.manifestStatus,
    canonicalModId: mod.canonicalModId || null,
    runtimeMatchMode: mod.runtimeMatchMode || "",
    source,
  };
}

function diagnoseFolderMod(mod, dutyPath) {
  const files = (mod.files || []).map(destOf).filter(Boolean);
  if (!dutyPath || !exists(dutyPath)) {
    return { status: "WARNING", issues: [{ code: "NO_DUTY", message: "The Duty folder is not set, so files cannot be checked." }] };
  }
  if (!files.length) {
    return { status: "WARNING", issues: [{ code: "NO_FILE_LIST", message: "This pack has no tracked files to verify." }] };
  }
  const missing = files.filter((rel) => {
    const norm = normalizeRel(rel);
    if (!norm || norm.split(path.sep).includes("..")) return true;
    return !pluginSupportLayout.destPresentOnDuty(dutyPath, rel);
  });
  if (missing.length === files.length) {
    return {
      status: "BROKEN",
      issues: [{ code: "MISSING_MANAGED_FILE", message: `All ${missing.length} tracked files are missing from the Duty folder.` }],
    };
  }
  if (missing.length) {
    return {
      status: "WARNING",
      issues: [
        {
          code: "MISSING_MANAGED_FILE",
          message: `${missing.length} of ${files.length} tracked files are missing, including ${missing[0]}.`,
        },
      ],
    };
  }
  const hay = `${files.join(" ")} ${(mod.kinds || []).join(" ")}`.toLowerCase();
  const vehicleLike = /\b(vehicle|map)\b/.test(hay) || /\.(yft|ytd|ydr|rpf)\b/.test(hay) || /[/\\]mods[/\\]/.test(hay);
  if (vehicleLike) {
    return {
      status: "WARNING",
      issues: [
        {
          code: "ARCHIVE_LIMIT",
          message: "Files are present. Encrypted Enhanced archives still may not load in-game without a supported install path.",
        },
      ],
    };
  }
  return { status: "HEALTHY", issues: [] };
}

function lampForStatus(status) {
  const key = String(status || "UNKNOWN").toUpperCase();
  if (key === "BROKEN") return { lamp: "bad", lampLabel: "Broken" };
  if (key === "DISABLED") return { lamp: "grey", lampLabel: "Disabled" };
  if (key === "WARNING" || key === "UNKNOWN") return { lamp: "warn", lampLabel: "Needs attention" };
  return { lamp: "ok", lampLabel: "Healthy" };
}

function evaluateOne(mod, context = {}) {
  const source = context.source || (mod.manifestStatus || mod.dependencySummary ? "SMART" : "FOLDER");
  const shaped = asSmartShape(mod, source);
  const diagnosis =
    context.diagnosis ||
    (source === "SMART" && context.dutyPath
      ? diagnoseManagedMod(mod, { dutyPath: context.dutyPath, dataDir: context.dataDir })
      : diagnoseFolderMod(shaped, context.dutyPath));
  const ident = runtimeCompatibility.identities(shaped, context.database);
  const health = modHealthV2.evaluateModHealth(shaped, {
    diagnosis,
    sessions: context.sessions || [],
    profiles: context.profiles || [],
    runtime:
      context.runtime ||
      runtimeCompatibility.lookupLive(context.runtimeDb || { mods: {} }, shaped, context.dutyPath, context.database, {
        dataDir: context.dataDir,
        mods: context.smartMods || context.mods,
        sessions: context.sessions || [],
      }),
    ignoreUnknownCompatibility: source === "FOLDER" || context.ignoreUnknownCompatibility === true,
    expectsRuntime: Boolean(ident.observables && ident.observables.length) && !ident.skip,
    healthyReason: source === "FOLDER" ? "Tracked files are present in the Duty folder." : undefined,
  });
  const lamp = lampForStatus(health.status);
  const extra = attachCalloutInterface(shaped, health, context);
  return {
    ...health,
    ...extra,
    name: shaped.name,
    source,
    lamp: lamp.lamp,
    lampLabel: lamp.lampLabel,
    lampDetail: (extra.reasons || health.reasons || [])[0] || lamp.lampLabel,
    issues: (diagnosis && diagnosis.issues) || [],
  };
}

function sessionLogText(context) {
  if (context.logText != null) return String(context.logText || "");
  try {
    return runtimeCompatibility.readSessionLogs((context.sessions || [])[0] || null, context.dutyPath);
  } catch {
    return "";
  }
}

function attachCalloutInterface(shaped, health, context) {
  if (!calloutInterfaceMdt.isCalloutInterface(shaped)) return {};
  const mdt = calloutInterfaceMdt.diagnose({
    dutyPath: context.dutyPath || "",
    logText: sessionLogText(context),
    mod: shaped,
    dataDir: context.dataDir || "",
  });
  const keybinds = keybindReader.readKeybinds({
    mod: shaped,
    dutyPath: context.dutyPath || "",
    canonicalModId: "callout-interface",
    database: context.database,
  });
  const reasons = [...(health.reasons || [])];
  if (mdt.mdtError && mdt.mdtError !== "NONE") {
    reasons.push(`MDT: ${mdt.mdtError}`);
  }
  return { mdt, keybinds, reasons };
}

function advice(rows = []) {
  const todos = (rows || []).filter((row) => row.nextStep && row.nextStep.needed);
  if (todos.length) {
    return todos.map((row) => `${row.name}: ${row.nextStep.do}`);
  }
  const broken = rows.filter((row) => row.status === "BROKEN");
  if (broken.length) {
    return broken.map((row) => `${row.name}: ${(row.reasons || [])[0] || "Needs a fix."}`);
  }
  const mdt = (rows || []).find((row) => row.mdt && row.mdt.mdtError && row.mdt.mdtError !== "NONE");
  if (mdt) return [`${mdt.name}: ${mdt.mdt.mdtError}`];
  return ["Nothing you need to do."];
}

function publicRow(row) {
  return {
    installId: row.installId,
    name: row.name,
    source: row.source,
    status: row.status,
    lamp: row.lamp,
    lampLabel: row.lampLabel,
    lampDetail: row.lampDetail,
    reasons: row.reasons || [],
    mdt: row.mdt || null,
  };
}

function destKey(file) {
  return String(typeof file === "string" ? file : (file && (file.destination || file.dest)) || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .toLowerCase();
}

function destSet(mod) {
  return new Set((mod.files || []).map(destKey).filter(Boolean));
}

function folderCoveredBySmart(folder, smartList) {
  const files = [...destSet(folder)];
  const notables = files.filter((dest) => /\.(dll|asi)$/i.test(dest));
  return (smartList || []).some((smart) => {
    const owned = destSet(smart);
    if (notables.length) {
      const hits = notables.filter((dest) => owned.has(dest)).length;
      return hits === notables.length || hits / notables.length >= 0.8;
    }
    if (!files.length) return false;
    const hits = files.filter((dest) => owned.has(dest)).length;
    return hits >= Math.max(1, Math.ceil(files.length * 0.8));
  });
}

function analyzeAll({
  folderMods = [],
  smartMods = [],
  dutyPath = "",
  dataDir = "",
  sessions = [],
  profiles = [],
  runtimeDb = null,
  database = null,
} = {}) {
  const db = runtimeDb || (dataDir ? runtimeCompatibility.loadEvidence(dataDir) : { mods: {} });
  const folder = (folderMods || []).map((mod) =>
    evaluateOne(mod, { source: "FOLDER", dutyPath, dataDir, sessions, profiles, runtimeDb: db, database })
  );
  const smart = (smartMods || []).map((mod) =>
    evaluateOne(mod, { source: "SMART", dutyPath, dataDir, sessions, profiles, runtimeDb: db, database, smartMods })
  );
  const covered = new Set((folderMods || []).filter((mod) => folderCoveredBySmart(mod, smartMods)).map((mod) => mod.id));
  const folderRows = folder.filter((row) => !covered.has(row.installId));
  const rows = [...smart, ...folderRows];
  return conditionFix.attachPlans(
    {
      at: new Date().toISOString(),
      folder,
      smart,
      rows,
      counts: modHealthV2.summarizeCounts(rows),
      advice: advice(rows),
    },
    { dutyPath, dataDir, folderMods, smartMods, database }
  );
}

function attachLamps(mods, context = {}) {
  return (mods || []).map((mod, index) => {
    const row = evaluateOne(mod, { ...context, source: context.source || "FOLDER" });
    return {
      ...mod,
      lamp: row.lamp,
      lampLabel: row.lampLabel,
      lampDetail: row.lampDetail,
      healthStatus: row.status,
      healthReasons: row.reasons,
      conditionId: row.installId || mod.id || `folder-${index}`,
    };
  });
}

module.exports = {
  asSmartShape,
  diagnoseFolderMod,
  lampForStatus,
  evaluateOne,
  advice,
  analyzeAll,
  attachLamps,
  publicRow,
  folderCoveredBySmart,
};
