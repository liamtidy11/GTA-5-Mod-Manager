const fs = require("fs");
const path = require("path");
const { exists } = require("../paths");
const { hasStoredFile } = require("../payloadStore");
const { isGameTreeDirName, normalizeDutyDest } = require("./gameTreeNormalize");
const dutyLayoutFix = require("./dutyLayoutFix");
const pluginSupportLayout = require("./pluginSupportLayout");
const dependencyGraph = require("../dependencyGraph");

const ACTIONS = {
  REPAIR_STORED: "REPAIR_STORED",
  HEAL_LAYOUT: "HEAL_LAYOUT",
  ENABLE_DEP: "ENABLE_DEP",
  NONE: "NONE",
};

function destOf(file) {
  return typeof file === "string" ? file : file.destination || file.dest || file.file || "";
}

function none(reason) {
  return { fixable: false, action: ACTIONS.NONE, reason, parkedDeps: [] };
}

function fix(action, reason, extras = {}) {
  return { fixable: true, action, reason, parkedDeps: extras.parkedDeps || [] };
}

function issueCodes(row = {}) {
  return new Set((row.issues || []).map((issue) => issue.code).filter(Boolean));
}

function reasonsText(row = {}) {
  return (row.reasons || []).join(" ").toLowerCase();
}

function humanComponentName(file) {
  const stem = String(file || "")
    .replace(/\.(dll|asi)$/i, "")
    .replace(/API$/i, "");
  const spaced = stem.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced || String(file || "that dependency");
}

function familyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(dll|asi|exe)$/i, "")
    .replace(/api$/i, "")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/\d+$/g, "");
}

function sameFamily(row, missingFile) {
  const want = familyKey(missingFile);
  if (!want || want.length < 4) return false;
  return [row.name, row.canonicalModId, row.installId].some((value) => {
    const key = familyKey(value);
    return Boolean(key && (key === want || (key.length >= 8 && want.length >= 8 && (key.includes(want) || want.includes(key)))));
  });
}

function dutyHasExactFile(dutyPath, missingFile) {
  if (!dutyPath || !missingFile) return false;
  const base = path.basename(String(missingFile));
  const dirs = [path.join("plugins", "LSPDFR"), "plugins", ""];
  return dirs.some((dir) => exists(dir ? path.join(dutyPath, dir, base) : path.join(dutyPath, base)));
}

function straySupportReason() {
  return "Remove RPH support DLLs from plugins\\LSPDFR (they belong next to the game exe), then Play LSPDFR again.";
}

function missingPluginLibraryReason(missing = []) {
  const names = (missing || []).map((row) => row.name).filter(Boolean).slice(0, 4).join(", ");
  return `Put ${names || "CalloutInterfaceAPI.dll"} next to the game exe (official IPT layout), then Play LSPDFR again.`;
}

function onlyWaiting(row = {}) {
  const reasons = row.reasons || [];
  if (!reasons.length) return false;
  return reasons.every((line) => /waiting for runtime|tracked files are present/i.test(String(line || "")));
}

function nextStep(row = {}, planned = null, options = {}) {
  const fix = planned || row.fix || none("No automatic fix is available.");
  if (row.status === "HEALTHY" || row.status === "DISABLED") {
    return { needed: false, do: "" };
  }
  if (fix.fixable) {
    return { needed: true, do: fix.reason, fixable: true };
  }
  const text = reasonsText(row);
  const evidence = String((row.runtime && row.runtime.evidence) || "");
  const dep = evidence.match(/dependency\s+([^\\/\s]+\.(?:dll|asi))\s+is not available/i);
  if (dep) {
    const atRoot = options.dutyPath && exists(path.join(options.dutyPath, path.basename(dep[1])));
    if (dutyHasExactFile(options.dutyPath, dep[1]) && !atRoot) {
      return {
        needed: true,
        do: `Put ${dep[1]} next to the game exe (official IPT layout), then Play LSPDFR again.`,
      };
    }
    if (atRoot) {
      return {
        needed: true,
        do: `${dep[1]} is next to the game exe but IPT still reported it missing. Exit the game fully, then Play LSPDFR again.`,
      };
    }
    if (sameFamily(row, dep[1])) {
      return {
        needed: true,
        do: `${dep[1]} did not load with this pack. Re-import the zip, or exit the game fully and Play LSPDFR again.`,
      };
    }
    return {
      needed: true,
      do: `Install ${humanComponentName(dep[1])}, then Play LSPDFR again.`,
    };
  }
  if (row.runtime && row.runtime.status === "FAILED") {
    return {
      needed: true,
      do: evidence
        ? `${evidence.replace(/^\[[^\]]+\]\s*/, "").replace(/^LSPD First Response:\s*/i, "")} Fix that, then Play LSPDFR again.`
        : "This plugin failed in the last Duty session. Fix the log error, then Play LSPDFR again.",
    };
  }
  if (onlyWaiting(row)) return { needed: false, do: "" };
  const codes = issueCodes(row);
  if (codes.has("ARCHIVE_LIMIT") || text.includes("encrypted enhanced archives")) {
    return { needed: false, do: "" };
  }
  if (text.includes("incompatible")) {
    return { needed: true, do: `Leave ${row.name || "this mod"} off or remove it. The app will not force it on.` };
  }
  if (fix.reason && fix.reason !== "No automatic fix is available.") {
    return { needed: true, do: fix.reason };
  }
  const first = (row.reasons || []).find((line) => !/waiting for runtime/i.test(String(line || "")));
  if (first) return { needed: true, do: first };
  return { needed: false, do: "" };
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function canRestoreFromStore(mod, dataDir, row = {}) {
  if (!mod || !dataDir) return false;
  const installId = mod.id || mod.installId || row.installId;
  if (!installId) return false;
  const candidates = [
    ...((row.issues || []).map((issue) => issue.file || destOf(issue))),
    ...((mod.files || []).map(destOf)),
  ].filter(Boolean);
  return candidates.some((rel) => hasStoredFile(dataDir, installId, rel) || hasStoredFile(dataDir, installId, normalizeDutyDest(rel)));
}

function canHealFromWrapper(dutyPath, files = []) {
  if (!dutyPath || !exists(dutyPath)) return false;
  const dests = files.map(destOf).map(normalizeDutyDest).filter(Boolean);
  if (!dests.length) return false;
  const wrappers = listDir(dutyPath).filter((entry) => entry.isDirectory() && isGameTreeDirName(entry.name));
  if (!wrappers.length) return false;
  return dests.some((dest) =>
    wrappers.some((entry) => exists(path.join(dutyPath, entry.name, dest.split("/").join(path.sep))))
  );
}

function parkedRequiredDeps(row, smartMods = [], database = null) {
  if (!database || !row || !row.installId) return [];
  const graph = dependencyGraph.build({ mods: smartMods, database });
  const deps = graph.forward.get(row.installId) || [];
  const out = [];
  for (const dep of deps) {
    if (String(dep.kind || "REQUIRED").toUpperCase() !== "REQUIRED" || !dep.satisfiedByInstallId) continue;
    const provider = smartMods.find((mod) => (mod.id || mod.installId) === dep.satisfiedByInstallId);
    if (provider && provider.enabled === false) {
      out.push({ installId: provider.id || provider.installId, name: provider.name || dep.name });
    }
  }
  return out;
}

function wantsPluginLayoutHeal(row = {}) {
  if (row.status === "HEALTHY" || row.status === "DISABLED") return false;
  const codes = issueCodes(row);
  if (codes.has("ARCHIVE_LIMIT")) return false;
  const text = `${row.name || ""} ${reasonsText(row)}`;
  if (text.includes("encrypted enhanced archives")) return false;
  if (row.runtime) return true;
  return /calloutinterface|grammarpolice|plugin|lspdfr/i.test(text);
}

function planRow(row = {}, options = {}) {
  const codes = issueCodes(row);
  const text = reasonsText(row);
  const parkedDeps = options.parkedDeps || [];
  const canRestore = options.canRestore === true;
  const canHeal = options.canHeal === true;

  if (row.status === "HEALTHY") return none("Nothing to fix.");
  if (row.status === "DISABLED") return none("This pack is disabled on purpose.");
  if (text.includes("incompatible")) {
    return none("Trusted data records this as incompatible. The app will not force it on.");
  }
  if (codes.has("ARCHIVE_LIMIT") || text.includes("encrypted enhanced archives")) {
    return none("Enhanced archives cannot be written automatically.");
  }
  if (codes.has("MANIFEST_ERROR") || text.includes("manifest") && text.includes("unreadable")) {
    return none("The manifest is unreadable, so files were left untouched.");
  }
  if (codes.has("NO_DUTY")) return none("Set the Duty folder first.");
  if (codes.has("NO_FILE_LIST")) return none("This pack has no tracked files to restore.");

  const missingFiles = codes.has("MISSING_MANAGED_FILE") || /missing from the duty folder|files are missing|managed files are missing/i.test(text);
  if (missingFiles) {
    if (canRestore && row.source === "SMART") {
      return fix(ACTIONS.REPAIR_STORED, "Restore missing files from the Smart Install copy.");
    }
    if (canHeal) {
      return fix(ACTIONS.HEAL_LAYOUT, "Move files from a wrapper folder into the Duty places plugins expect.");
    }
    if (row.source === "SMART") {
      return none("No stored copy exists. Re-import the zip through Smart Install.");
    }
    return none("This folder pack is missing files and has no stored copy. Re-import the zip.");
  }

  if (parkedDeps.length) {
    return fix(
      ACTIONS.ENABLE_DEP,
      `Re-enable ${parkedDeps.map((dep) => dep.name).slice(0, 3).join(", ")}.`,
      { parkedDeps }
    );
  }

  if (wantsPluginLayoutHeal(row) && (options.missingPluginLibraries || []).length) {
    return fix(ACTIONS.HEAL_LAYOUT, missingPluginLibraryReason(options.missingPluginLibraries));
  }

  if (wantsPluginLayoutHeal(row) && (options.straySupportDlls || []).length) {
    return fix(ACTIONS.HEAL_LAYOUT, straySupportReason());
  }

  if (row.runtime && row.runtime.status === "FAILED") {
    return none("The last Duty session showed this plugin failed to stay loaded. Restoring files will not change that log.");
  }
  if (text.includes("compatibility") && text.includes("unknown")) {
    return none("Compatibility is unknown. A clean Duty session can turn this green; the app cannot invent Enhanced support.");
  }
  if (text.includes("correlation, not proof")) {
    return none("Session correlation is not a file error the app can rewrite.");
  }
  if (text.includes("changed outside")) {
    return none("A file changed outside the manager. Restore from Details only if you want the stored copy back.");
  }
  return none("No automatic fix is available.");
}

function attachPlans(analysis, { dutyPath = "", dataDir = "", folderMods = [], smartMods = [], database = null } = {}) {
  const bySmart = new Map((smartMods || []).map((mod) => [mod.id || mod.installId, mod]));
  const byFolder = new Map((folderMods || []).map((mod) => [mod.id, mod]));
  const straySupportDlls = dutyPath ? pluginSupportLayout.findStraySupportDlls(dutyPath) : [];
  const missingPluginLibraries = dutyPath ? pluginSupportLayout.findMissingPluginLibraries(dutyPath) : [];
  const summary = (analysis.rows || []).map((row) => {
    const original = row.source === "SMART" ? bySmart.get(row.installId) : byFolder.get(row.installId);
    const files = (original && original.files) || [];
    const fix = planRow(row, {
      canRestore: canRestoreFromStore(original || { id: row.installId, files }, dataDir, row),
      canHeal: canHealFromWrapper(dutyPath, files),
      parkedDeps: parkedRequiredDeps(row, smartMods, database),
      straySupportDlls,
      missingPluginLibraries,
    });
    const step = nextStep({ ...row, fix }, fix, { dutyPath, straySupportDlls, missingPluginLibraries });
    return {
      installId: row.installId,
      name: row.name,
      source: row.source,
      status: row.status,
      lamp: row.lamp,
      lampLabel: row.lampLabel,
      lampDetail: row.lampDetail,
      reasons: row.reasons || [],
      runtime: row.runtime || null,
      issues: row.issues || [],
      fix,
      nextStep: step,
    };
  });
  const seenDo = new Set();
  const todos = summary.filter((row) => {
    if (!row.nextStep || !row.nextStep.needed) return false;
    const key = String(row.nextStep.do || "").toLowerCase();
    if (key && seenDo.has(key)) return false;
    if (key) seenDo.add(key);
    return true;
  });
  return {
    ...analysis,
    summary,
    todos,
    advice: todos.length ? todos.map((row) => `${row.name}: ${row.nextStep.do}`) : ["Nothing you need to do."],
    fixableCount: summary.filter((row) => row.fix && row.fix.fixable).length,
  };
}

function assertDutyOnly({ dutyPath, officialPath }) {
  if (!dutyPath) throw new Error("The Duty folder is not set.");
  if (officialPath && path.resolve(dutyPath).toLowerCase() === path.resolve(officialPath).toLowerCase()) {
    throw new Error("Refusing to change the official Online folder.");
  }
}

async function applyPlans(plans, ctx = {}) {
  assertDutyOnly(ctx);
  const wanted = (plans || []).filter((plan) => plan && plan.fixable);
  const results = [];
  const healNeeded = wanted.some((plan) => plan.action === ACTIONS.HEAL_LAYOUT || plan.action === ACTIONS.REPAIR_STORED);
  let healed = null;
  if (healNeeded) {
    const heal = ctx.healDutyLayout || dutyLayoutFix.healDutyLayout;
    healed = heal({ dutyPath: ctx.dutyPath, dataDir: ctx.dataDir });
  }

  for (const plan of wanted) {
    if (plan.action === ACTIONS.HEAL_LAYOUT) {
      results.push({
        installId: plan.installId,
        name: plan.name,
        ok: true,
        action: plan.action,
        message:
          healed && healed.mirroredLibraries && healed.mirroredLibraries.length
            ? `Copied ${healed.mirroredLibraries.map((rel) => path.basename(rel)).join(", ")} into plugins\\LSPDFR.`
            : healed && healed.removedSupport && healed.removedSupport.length
              ? "Removed RPH support DLLs from plugins\\LSPDFR."
              : healed && healed.changed
                ? "Moved files into the Duty folders plugins expect."
                : "No wrapper files needed moving.",
      });
      continue;
    }
    if (plan.action === ACTIONS.REPAIR_STORED) {
      try {
        const repaired = await ctx.repair({
          modId: plan.installId,
          dutyPath: ctx.dutyPath,
          dataDir: ctx.dataDir,
        });
        const n = (repaired && repaired.restored && repaired.restored.length) || 0;
        results.push({
          installId: plan.installId,
          name: plan.name,
          ok: true,
          action: plan.action,
          restored: repaired && repaired.restored,
          skipped: repaired && repaired.skipped,
          message: n ? `Restored ${n} stored file(s).` : "Repair ran, but no stored file was copied.",
        });
      } catch (error) {
        results.push({
          installId: plan.installId,
          name: plan.name,
          ok: false,
          action: plan.action,
          message: error.message || String(error),
        });
      }
      continue;
    }
    if (plan.action === ACTIONS.ENABLE_DEP) {
      const names = [];
      for (const dep of plan.parkedDeps || []) {
        try {
          await ctx.setEnabled({
            modId: dep.installId,
            dutyPath: ctx.dutyPath,
            dataDir: ctx.dataDir,
            enabled: true,
          });
          names.push(dep.name);
        } catch (error) {
          results.push({
            installId: plan.installId,
            name: plan.name,
            ok: false,
            action: plan.action,
            message: error.message || String(error),
          });
        }
      }
      if (names.length) {
        results.push({
          installId: plan.installId,
          name: plan.name,
          ok: true,
          action: plan.action,
          message: `Re-enabled ${names.join(", ")}.`,
        });
      }
    }
  }

  return {
    healed,
    results,
    fixed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
  };
}

module.exports = {
  ACTIONS,
  none,
  planRow,
  attachPlans,
  nextStep,
  humanComponentName,
  familyKey,
  sameFamily,
  canRestoreFromStore,
  canHealFromWrapper,
  parkedRequiredDeps,
  assertDutyOnly,
  applyPlans,
};
