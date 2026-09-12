const environmentInventory = require("./environmentInventory");
const versionDetector = require("./versionDetector");
const modKnowledge = require("./modKnowledge");

// Runtime compatibility only. Install safety lives in recommendationEngine.
// Does not re-enable parked components or rewrite launch behavior.

const LOCAL_PARKED = new Set(["scripthookv", "scripthookvdotnet"]);

const STATUS_RANK = {
  VERIFIED: 0,
  LIKELY_COMPATIBLE: 1,
  UNKNOWN: 2,
  WARNING: 3,
  INCOMPATIBLE: 4,
};

function finding({ code, severity = "INFO", status = "UNKNOWN", message, why, source, action = "" }) {
  return {
    code,
    severity,
    status,
    message,
    why: why || message,
    source,
    action,
  };
}

function knowledgeEntry(recognition, database) {
  if (recognition && recognition.knowledge) return recognition.knowledge;
  if (recognition && recognition.modId) return modKnowledge.findById(database, recognition.modId);
  return null;
}

function inventoryComponent(inventory, id) {
  if (!inventory) return null;
  return environmentInventory.findComponent(inventory, id) || null;
}

function componentVersion(inventory, id) {
  const item = inventoryComponent(inventory, id);
  if (item && item.version) return item.version;
  if (id === "lspdfr" && inventory && inventory.lspdfr) return inventory.lspdfr.version || "UNKNOWN";
  if (id === "rage-plugin-hook" && inventory && inventory.ragePluginHook) {
    return inventory.ragePluginHook.version || "UNKNOWN";
  }
  if (id === "gta-enhanced" && inventory && inventory.gta) return inventory.gta.version || "UNKNOWN";
  return "UNKNOWN";
}

function evaluateVersionRule(rule, installed, label, codePrefix, source) {
  if (!rule) return [];
  const checks = [];
  if (rule.requirement) checks.push(rule.requirement);
  else {
    if (rule.min) checks.push(`>= ${rule.min}`);
    if (rule.max) checks.push(`<= ${rule.max}`);
    if (rule.exact) checks.push(`= ${rule.exact}`);
  }
  if (!checks.length) return [];

  const out = [];
  for (const requirement of checks) {
    const result = versionDetector.satisfiesVersion(installed, requirement);
    if (result.status === "UNKNOWN" || result.status === "INVALID_REQUIREMENT") {
      out.push(
        finding({
          code: `${codePrefix}_VERSION_UNKNOWN`,
          severity: "LOW",
          status: "UNKNOWN",
          message: `${label} is installed, but its version is UNKNOWN so ${requirement} cannot be verified.`,
          why: "An unknown version is not treated as incompatible.",
          source,
        })
      );
      continue;
    }
    if (result.status === "TOO_OLD" || result.status === "TOO_NEW") {
      out.push(
        finding({
          code: `${codePrefix}_VERSION`,
          severity: "HIGH",
          status: "WARNING",
          message: `${label} ${installed} does not satisfy the trusted requirement ${requirement}.`,
          why: "The installed version is outside the range recorded in the knowledge database.",
          source,
          action: `Update ${label} or use a package that supports ${installed}.`,
        })
      );
      continue;
    }
    out.push(
      finding({
        code: `${codePrefix}_VERSION_OK`,
        severity: "INFO",
        status: "LIKELY_COMPATIBLE",
        message: `${label} ${installed} satisfies ${requirement}.`,
        why: "The installed version meets the trusted requirement.",
        source,
      })
    );
  }
  return out;
}

function gtaFinding(compat) {
  const value = (compat && compat.gtaEnhanced) || "UNKNOWN";
  const source = "KNOWLEDGE_DATABASE";
  if (value === "VERIFIED") {
    return finding({
      code: "GTA_ENHANCED",
      severity: "INFO",
      status: "VERIFIED",
      message: "Trusted data marks this mod as verified for GTA V Enhanced.",
      source,
    });
  }
  if (value === "LIKELY") {
    return finding({
      code: "GTA_ENHANCED",
      severity: "INFO",
      status: "LIKELY_COMPATIBLE",
      message: "Trusted data marks this mod as likely compatible with GTA V Enhanced.",
      source,
    });
  }
  if (value === "WARNING") {
    return finding({
      code: "GTA_ENHANCED",
      severity: "MEDIUM",
      status: "WARNING",
      message: "Trusted data warns that GTA V Enhanced support for this mod is incomplete.",
      source,
    });
  }
  if (value === "INCOMPATIBLE") {
    return finding({
      code: "GTA_ENHANCED",
      severity: "CRITICAL",
      status: "INCOMPATIBLE",
      message: "Trusted data says this mod should not be used with GTA V Enhanced.",
      why: "The knowledge database records an Enhanced incompatibility for this identity.",
      source,
      action: "Do not install this pack into the Duty folder.",
    });
  }
  return finding({
    code: "GTA_ENHANCED",
    severity: "INFO",
    status: "UNKNOWN",
    message: "GTA V Enhanced compatibility has not been verified for this mod.",
    why: "Missing catalog evidence is not a failure. Installation can still be safe.",
    source,
  });
}

function describeDisabled(dep) {
  if (LOCAL_PARKED.has(dep.modId)) {
    return `${dep.name} is required but currently parked in this Duty setup. The manager will not re-enable it.`;
  }
  return `${dep.name} is required but currently disabled.`;
}

function dependencyFindings(dependencies) {
  const out = [];
  for (const dep of dependencies || []) {
    if (dep.kind === "REQUIRED" && dep.state === "MISSING") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_MISSING",
          severity: "HIGH",
          status: "WARNING",
          message: `${dep.name} is required and was not detected in the LSPDFR folder.`,
          why: "The plugin is likely to fail at runtime without this dependency.",
          source: "DEPENDENCY_RESOLVER",
          action: `Install ${dep.name} before using this pack.`,
        })
      );
    } else if (dep.kind === "REQUIRED" && dep.state === "DISABLED") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_DISABLED",
          severity: "HIGH",
          status: "WARNING",
          message: describeDisabled(dep),
          why: "A parked dependency is present on disk but not active. It will not be turned back on automatically.",
          source: "DEPENDENCY_RESOLVER",
        })
      );
      if (LOCAL_PARKED.has(dep.modId)) {
        out.push(
          finding({
            code: "LOCAL_ENVIRONMENT_WARNING",
            severity: "MEDIUM",
            status: "WARNING",
            message: `${dep.name} is currently disabled in this Duty profile due to previous instability.`,
            why: "This is local environment safety context, not a global claim that the component never works with GTA Enhanced.",
            source: "LOCAL_ENVIRONMENT",
          })
        );
      }
    } else if (dep.kind === "REQUIRED" && dep.state === "VERSION_TOO_OLD") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_TOO_OLD",
          severity: "HIGH",
          status: "WARNING",
          message: `${dep.name} ${dep.installedVersion} is installed, but this mod requires ${dep.requiredVersion}.`,
          why: "The installed dependency is older than the stated requirement.",
          source: "DEPENDENCY_RESOLVER",
          action: `Update ${dep.name} to ${dep.requiredVersion}.`,
        })
      );
    } else if (dep.kind === "REQUIRED" && dep.state === "VERSION_TOO_NEW") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_TOO_NEW",
          severity: "MEDIUM",
          status: "WARNING",
          message: `${dep.name} ${dep.installedVersion} is newer than the stated requirement ${dep.requiredVersion}.`,
          why: "Newer is not assumed to be compatible.",
          source: "DEPENDENCY_RESOLVER",
        })
      );
    } else if (dep.kind === "REQUIRED" && dep.state === "INCOMPATIBLE") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_INCOMPATIBLE",
          severity: "CRITICAL",
          status: "INCOMPATIBLE",
          message: `${dep.name} is marked incompatible by trusted dependency metadata.`,
          why: dep.message || "Dependency metadata records that these components should not be used together.",
          source: "DEPENDENCY_RESOLVER",
        })
      );
    } else if (dep.kind === "REQUIRED" && dep.state === "UNKNOWN") {
      out.push(
        finding({
          code: "REQUIRED_DEPENDENCY_VERSION_UNKNOWN",
          severity: "LOW",
          status: "UNKNOWN",
          message: `${dep.name} is installed, but its version is UNKNOWN so ${dep.requiredVersion || "the requirement"} cannot be verified.`,
          why: "An unknown installed version is not treated as a failure.",
          source: "DEPENDENCY_RESOLVER",
        })
      );
    } else if ((dep.kind === "OPTIONAL" || dep.kind === "RECOMMENDED") && dep.state === "MISSING") {
      out.push(
        finding({
          code: "OPTIONAL_DEPENDENCY_MISSING",
          severity: "LOW",
          status: "UNKNOWN",
          message: `${dep.name} is ${String(dep.kind).toLowerCase()} and is not installed.`,
          why: "Optional and recommended dependencies are not treated as install failures.",
          source: "DEPENDENCY_RESOLVER",
        })
      );
    } else if (dep.kind === "REQUIRED" && (dep.state === "INSTALLED" || dep.state === "BUNDLED")) {
      out.push(
        finding({
          code: dep.state === "BUNDLED" ? "REQUIRED_DEPENDENCY_BUNDLED" : "REQUIRED_DEPENDENCY_OK",
          severity: "INFO",
          status: "LIKELY_COMPATIBLE",
          message: dep.message || `${dep.name} is available.`,
          source: "DEPENDENCY_RESOLVER",
        })
      );
    }
  }
  return out;
}

function matchInstalled(targetId, { inventory, installedMods, database }) {
  const entry = modKnowledge.findById(database, targetId);
  const labels = new Set(
    [targetId, entry && entry.id, entry && entry.name, ...((entry && entry.aliases) || [])]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase())
  );
  const dlls = new Set(((entry && entry.recognition && entry.recognition.dllNames) || []).map((n) => n.toLowerCase()));

  const listed = (installedMods || []).filter(
    (mod) =>
      labels.has(String(mod.modId || "").toLowerCase()) ||
      labels.has(String(mod.id || "").toLowerCase()) ||
      labels.has(String(mod.name || "").toLowerCase())
  );
  const enabledListed = listed.find((mod) => mod.enabled !== false);
  const parkedListed = listed.find((mod) => mod.enabled === false);

  const component = inventoryComponent(inventory, targetId);
  const plugin = ((inventory && inventory.plugins) || []).find((p) => dlls.has(String(p.name || "").toLowerCase()));
  const framework = ((inventory && inventory.frameworks) || []).find((f) => f.id === targetId);

  const enabled =
    Boolean(enabledListed) ||
    Boolean(component && component.state === "INSTALLED" && component.enabled) ||
    Boolean(plugin && plugin.enabled !== false) ||
    Boolean(framework && framework.enabled !== false);
  const parked =
    Boolean(parkedListed) ||
    Boolean(component && component.state === "PARKED") ||
    Boolean(plugin && plugin.enabled === false);

  return { enabled, parked, name: (entry && entry.name) || targetId };
}

function logicalFindings(entry, context) {
  const out = [];
  const relations = [...((entry && entry.incompatibleWith) || []), ...((entry && entry.conflicts) || [])];
  const seen = new Set();
  for (const rel of relations) {
    const id = rel.modId || rel.componentId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const hit = matchInstalled(id, context);
    const reason = rel.reason || "The knowledge database records a logical conflict between these mods.";
    if (hit.enabled) {
      const incompatible = (entry.incompatibleWith || []).some((item) => (item.modId || item.componentId) === id);
      out.push(
        finding({
          code: incompatible ? "KNOWN_INCOMPATIBLE_COMPONENT" : "LOGICAL_CONFLICT",
          severity: rel.severity || "HIGH",
          status: incompatible ? "INCOMPATIBLE" : "WARNING",
          message: `${hit.name} is installed and enabled. ${reason}`,
          why: reason,
          source: "KNOWLEDGE_DATABASE",
        })
      );
    } else if (hit.parked) {
      out.push(
        finding({
          code: "PARKED_CONFLICT",
          severity: "INFO",
          status: "UNKNOWN",
          message: `${hit.name} is a known conflict but is currently parked, so it is not an active conflict.`,
          why: "Only enabled mods are treated as active logical conflicts.",
          source: "KNOWLEDGE_DATABASE",
        })
      );
    }
  }
  return out;
}

function packageFindings(packageCompatibility, dependencies) {
  const known = new Set((dependencies || []).map((d) => d.modId).filter(Boolean));
  const out = [];
  for (const item of packageCompatibility || []) {
    const id = String(item.modId || item.name || "").toLowerCase();
    if (id.includes("scripthook") && (known.has("scripthookvdotnet") || known.has("scripthookv"))) {
      continue;
    }
    if (item.level === "incompatible") {
      out.push(
        finding({
          code: "PACKAGE_RISKY_DEPENDENCY",
          severity: "HIGH",
          status: "WARNING",
          message: item.note || `${item.name} looks incompatible with this Duty setup.`,
          why: "This comes from package metadata, not a global Enhanced compatibility claim.",
          source: "PACKAGE_METADATA",
        })
      );
    }
  }
  return out;
}

function rollupStatus(findings) {
  let worst = "UNKNOWN";
  let hasVerified = false;
  let hasLikely = false;
  let hasUnknown = false;
  for (const item of findings) {
    if (item.status === "INCOMPATIBLE") return "INCOMPATIBLE";
    if (item.status === "WARNING") worst = "WARNING";
    if (item.status === "VERIFIED") hasVerified = true;
    if (item.status === "LIKELY_COMPATIBLE") hasLikely = true;
    if (item.status === "UNKNOWN" && (item.code === "GTA_ENHANCED" || /_VERSION_UNKNOWN$/.test(item.code))) {
      hasUnknown = true;
    }
  }
  if (worst === "WARNING") return "WARNING";
  if (hasVerified && !hasUnknown) return "VERIFIED";
  if (hasLikely && !hasUnknown) return "LIKELY_COMPATIBLE";
  if (hasVerified && hasUnknown) return "LIKELY_COMPATIBLE";
  return "UNKNOWN";
}

function rollupConfidence({ findings, dependencies, knowledge }) {
  const hasVersionRule = findings.some((f) => /_VERSION/.test(f.code) && f.status !== "UNKNOWN");
  const hasTrustedGta = findings.some((f) => f.code === "GTA_ENHANCED" && (f.status === "VERIFIED" || f.status === "INCOMPATIBLE"));
  const required = (dependencies || []).filter((d) => d.kind === "REQUIRED");
  const readmeOnly = required.length > 0 && required.every((d) => (d.sources || [d.source]).every((s) => s === "README"));
  if (hasTrustedGta || hasVersionRule) return "HIGH";
  if (knowledge && required.some((d) => (d.sources || []).includes("KNOWLEDGE_DATABASE") || d.source === "KNOWLEDGE_DATABASE")) {
    return "MEDIUM";
  }
  if (readmeOnly) return "LOW";
  if (!knowledge && !required.length) return "UNKNOWN";
  return "MEDIUM";
}

function evaluate({
  recognition = null,
  inventory = null,
  dutyPath = "",
  dataDir = "",
  dependencies = [],
  installedMods = [],
  packageCompatibility = [],
  database = null,
} = {}) {
  const db = database || modKnowledge.load();
  const env =
    inventory ||
    environmentInventory.getInventory({
      dutyPath,
      dataDir,
      deps: {
        overlayStatus: () => ({ nvidiaOverlay: false, nvidiaShare: false }),
        cortexRunning: () => false,
      },
    });
  const entry = knowledgeEntry(recognition, db);
  const compat = (entry && entry.compatibility) || { gtaEnhanced: "UNKNOWN", lspdfr: {}, ragePluginHook: {} };

  const findings = [];
  findings.push(gtaFinding(compat));
  findings.push(
    ...evaluateVersionRule(
      compat.lspdfr,
      componentVersion(env, "lspdfr"),
      "LSPDFR",
      "LSPDFR",
      "KNOWLEDGE_DATABASE"
    )
  );
  findings.push(
    ...evaluateVersionRule(
      compat.ragePluginHook,
      componentVersion(env, "rage-plugin-hook"),
      "RAGE Plugin Hook",
      "RPH",
      "KNOWLEDGE_DATABASE"
    )
  );
  findings.push(...dependencyFindings(dependencies));
  findings.push(...logicalFindings(entry, { inventory: env, installedMods, database: db }));
  findings.push(...packageFindings(packageCompatibility, dependencies));

  return {
    status: rollupStatus(findings),
    confidence: rollupConfidence({ findings, dependencies, knowledge: entry }),
    findings,
  };
}

module.exports = {
  evaluate,
  finding,
  LOCAL_PARKED,
  STATUS_RANK,
};
