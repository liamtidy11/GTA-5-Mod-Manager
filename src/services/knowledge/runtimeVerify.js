const path = require("path");
const runtimeCompatibility = require("./runtimeCompatibility");
const runtimeSignals = require("./runtimeSignals");
const runtimeRuleStore = require("./runtimeRuleStore");
const dllOwnership = require("./dllOwnership");

const STATES = {
  WORKING: "WORKING",
  FAILED: "FAILED",
  UNVERIFIED: "UNVERIFIED",
  SKIPPED: "SKIPPED",
};

function ruleMatches(rule, text, ident) {
  if (!rule) return null;
  const fromSignals = runtimeSignals.scanSignals(text, rule.positiveSignals || []);
  if (fromSignals) {
    return {
      status: STATES.WORKING,
      tier: rule.source || "BUILT_IN",
      kind: fromSignals.type || "RULE",
      evidence: fromSignals.evidence,
      confidence: rule.source === "USER_OVERRIDE" || rule.source === "LOCAL_VERIFIED" ? "HIGH" : "HIGH",
      matchMode: rule.matchMode || "PRIMARY",
    };
  }
  return null;
}

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function ownedLogVerdict(ident, logFiles) {
  if (!logFiles || !logFiles.length || ident.skip) return null;
  for (const file of logFiles) {
    const label = String(file.name || "").replace(/\.(log|txt)$/i, "");
    const stem = compact(label);
    if (stem.length < 4) continue;
    const owned = (ident.observables || []).some((item) => compact(item.stem) === stem);
    if (!owned) continue;
    const text = String(file.text || "");
    const fail = runtimeSignals.matchFailureGeneric(text, ident);
    if (fail) {
      return {
        status: STATES.FAILED,
        tier: "GENERIC_PLUGIN",
        kind: fail.type,
        evidence: fail.evidence,
        confidence: "HIGH",
      };
    }
    if (
      /\b(?:init(?:ialization)? (?:finished|complete|ok)|initialized successfully|loaded successfully|started successfully|adjusted to)\b/i.test(
        text
      )
    ) {
      const line =
        text
          .split(/\r?\n/)
          .map((row) => row.trim())
          .find((row) => row.length > 4) || `${label} log`;
      return {
        status: STATES.WORKING,
        tier: "GENERIC_PLUGIN",
        kind: "OWN_LOG",
        evidence: line.slice(0, 240),
        confidence: "HIGH",
      };
    }
    if ((ident.observables || []).some((item) => item.kind === "ASI" && compact(item.stem) === stem) && text.trim().length >= 12) {
      return {
        status: STATES.WORKING,
        tier: "GENERIC_PLUGIN",
        kind: "OWN_LOG",
        evidence: `${label} wrote a Duty log this session.`,
        confidence: "MEDIUM",
      };
    }
  }
  return null;
}

function genericPlugin(mod, ident, text) {
  if (ident.skip || ident.hook || !ident.observables.length) return null;
  const mode = String(mod.runtimeMatchMode || "PRIMARY").toUpperCase();
  const needed = ident.observables.filter((item) => !item.library);
  const targets = needed.length ? needed : ident.observables;
  if (mode === "ALL") {
    const hits = targets.map((item) => {
      const stem = String(item.stem || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      return runtimeSignals.matchPositiveGeneric(text, {
        observables: [item],
        tokens: stem.length >= 4 ? [stem] : [],
        abbrevs: [],
      });
    });
    if (hits.some((hit) => !hit)) return null;
    return {
      status: STATES.WORKING,
      tier: "GENERIC_PLUGIN",
      kind: hits[0].type,
      evidence: hits[0].evidence,
      confidence: "HIGH",
      matchMode: "ALL",
    };
  }
  const hit = runtimeSignals.matchPositiveGeneric(text, ident);
  if (!hit) return null;
  return {
    status: STATES.WORKING,
    tier: "GENERIC_PLUGIN",
    kind: hit.type,
    evidence: hit.evidence,
    confidence: "HIGH",
    matchMode: mode === "ANY" ? "ANY" : "PRIMARY",
  };
}

function genericFramework(mod, ident, text, context = {}) {
  if (ident.skip) return null;
  const builtIn = runtimeRuleStore.findBuiltInRule(mod, context.builtInRules || runtimeRuleStore.loadBuiltIn());
  const hay = [mod.canonicalModId, mod.category, mod.type, mod.name].filter(Boolean).join(" ").toLowerCase();
  const frameworkLike =
    (ident.observables.length > 0 && ident.observables.every((item) => item.library)) ||
    /\b(framework|dependency|nativeui|lemonui|ifruit)\b/.test(hay) ||
    (builtIn && builtIn.kind === "FRAMEWORK");
  if (!frameworkLike) return null;
  const direct = runtimeSignals.matchPositiveGeneric(text, ident);
  if (direct) {
    return {
      status: STATES.WORKING,
      tier: "GENERIC_FRAMEWORK",
      kind: direct.type || "FRAMEWORK_LOADED",
      evidence: direct.evidence,
      confidence: "HIGH",
    };
  }
  if (context.skipFrameworkIndirect) return null;
  if (!(builtIn && builtIn.allowIndirect)) return null;
  const canonical = mod.canonicalModId;
  const catalog = context.catalog;
  if (!canonical || !catalog) return null;
  const requiredBy = (catalog.mods || []).filter((entry) =>
    (entry.dependencies || []).some((dep) => dep.modId === canonical && String(dep.kind || "REQUIRED").toUpperCase() === "REQUIRED")
  );
  if (!requiredBy.length) return null;
  for (const other of context.mods || []) {
    if (other.enabled === false) continue;
    if (!requiredBy.some((entry) => entry.id === other.canonicalModId)) continue;
    const child = evaluate(other, { ...context, skipFrameworkIndirect: true, logText: text });
    if (child.status === STATES.WORKING) {
      return {
        status: STATES.WORKING,
        tier: "GENERIC_FRAMEWORK",
        kind: "INDIRECT",
        evidence: `${other.name || other.canonicalModId} loaded and requires this framework.`,
        confidence: "MEDIUM",
      };
    }
  }
  return null;
}

function evaluate(mod, context = {}) {
  const ident = runtimeCompatibility.identities(mod, context.catalog);
  const text = String(context.logText || "");
  if (ident.skip) {
    return { status: STATES.SKIPPED, tier: "UNVERIFIED", kind: "SKIPPED", evidence: "", confidence: "NONE" };
  }

  const failure = runtimeSignals.matchFailureGeneric(text, ident);
  if (failure) {
    return {
      status: STATES.FAILED,
      tier: "GENERIC_PLUGIN",
      kind: failure.type,
      evidence: failure.evidence,
      confidence: "HIGH",
    };
  }

  const ownLog = ownedLogVerdict(ident, context.logFiles);
  if (ownLog) return ownLog;

  if (ident.hook) {
    const hook = /Rage Plugin Hook started/i.test(text) && /(?:Unloading plugins|Plugin hook is shutting down|Normal shutdown)/i.test(text);
    return hook
      ? { status: STATES.WORKING, tier: "GENERIC_PLUGIN", kind: "HOOK_LOG", evidence: "Rage Plugin Hook started and shut down cleanly.", confidence: "HIGH" }
      : { status: STATES.UNVERIFIED, tier: "UNVERIFIED", kind: "HOOK_UNSEEN", evidence: "", confidence: "NONE" };
  }

  const userDb = context.userRules || (context.dataDir ? runtimeRuleStore.loadUser(context.dataDir) : { rules: {} });
  const userRule = runtimeRuleStore.findUserRule(userDb, mod);
  if (userRule && userRule.source === "USER_OVERRIDE") {
    const hit = ruleMatches(userRule, text, ident);
    if (hit) return hit;
  }
  if (userRule && userRule.source === "LOCAL_VERIFIED") {
    const hit = ruleMatches(userRule, text, ident);
    if (hit) return { ...hit, tier: "LOCAL_VERIFIED" };
  }

  const builtIn = runtimeRuleStore.findBuiltInRule(mod, context.builtInRules || runtimeRuleStore.loadBuiltIn());
  const pluginOwned = (ident.observables || []).some((item) => !item.library);
  if (builtIn && !(builtIn.kind === "FRAMEWORK" && pluginOwned)) {
    const hit = ruleMatches(builtIn, text, ident);
    if (hit) return { ...hit, tier: "BUILT_IN" };
  }

  const plugin = genericPlugin(mod, ident, text);
  if (plugin) return plugin;

  const framework = genericFramework(mod, ident, text, context);
  if (framework) return framework;

  if (ident.silent) {
    return { status: STATES.UNVERIFIED, tier: "UNVERIFIED", kind: "SILENT", evidence: "", confidence: "NONE", silent: true };
  }
  return { status: STATES.UNVERIFIED, tier: "UNVERIFIED", kind: ident.observables.length ? "PLUGIN_UNSEEN" : "UNOBSERVABLE", evidence: "", confidence: "NONE" };
}

function sameFingerprint(stored, mod, sessionMod) {
  if (!stored) return false;
  const live = dllOwnership.fingerprint(mod);
  const sessionVersion = sessionMod && sessionMod.version;
  if (stored.version && live.version && stored.version !== "UNKNOWN" && live.version !== "UNKNOWN" && stored.version !== live.version) {
    return false;
  }
  if (sessionVersion && live.version && sessionVersion !== "UNKNOWN" && live.version !== "UNKNOWN" && sessionVersion !== live.version) {
    return false;
  }
  if (stored.hash && live.hash && stored.hash !== live.hash) return false;
  return true;
}

function toLegacy(verdict) {
  if (!verdict) return { status: null, kind: "UNOBSERVABLE", evidence: "" };
  if (verdict.status === STATES.FAILED) return { status: "FAILED", kind: verdict.kind || "PLUGIN_LOG", evidence: verdict.evidence || "" };
  if (verdict.status === STATES.WORKING) return { status: "LOADED", kind: verdict.kind || "PLUGIN_LOG", evidence: verdict.evidence || "" };
  if (verdict.silent) return { status: "SILENT", kind: "SILENT", evidence: "" };
  if (verdict.status === STATES.SKIPPED) return { status: null, kind: "SKIPPED", evidence: "" };
  return { status: null, kind: verdict.kind || "PLUGIN_UNSEEN", evidence: "" };
}

function suggestSignals(mod, logText, catalog) {
  const ident = runtimeCompatibility.identities(mod, catalog);
  return runtimeSignals.distinctiveLines(logText, ident);
}

module.exports = {
  STATES,
  evaluate,
  ownedLogVerdict,
  ruleMatches,
  genericPlugin,
  genericFramework,
  sameFingerprint,
  toLegacy,
  suggestSignals,
  builtInRulesPath: path.join(__dirname, "..", "..", "data", "runtimeRules.json"),
};
