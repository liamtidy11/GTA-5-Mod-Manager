const fs = require("fs");
const path = require("path");
const environmentInventory = require("./environmentInventory");
const versionDetector = require("./versionDetector");
const modKnowledge = require("./modKnowledge");
const manifestStore = require("./manifestStore");
const { tactixDir, exists } = require("./paths");

// Resolves required/optional/recommended dependencies against the Duty
// inventory. README evidence never overwrites trusted sources.
// Does not re-enable parked components or download anything.

const SOURCE_RANK = {
  APP_MANIFEST: 4,
  KNOWLEDGE_DATABASE: 3,
  PACKAGE_METADATA: 2,
  README: 1,
};

function rank(source) {
  return SOURCE_RANK[source] || 0;
}

function asKind(value, fallback = "REQUIRED") {
  const kind = String(value || fallback).toUpperCase();
  return ["REQUIRED", "OPTIONAL", "RECOMMENDED", "UNKNOWN"].includes(kind) ? kind : fallback;
}

function claim({ modId, name, kind, source, confidence, version, evidence, notes, file, incompatible }) {
  return {
    modId: modId || "",
    name: name || modId || "Unknown",
    kind: asKind(kind, "UNKNOWN"),
    source: source || "README",
    confidence: confidence || "UNKNOWN",
    version: version || "",
    evidence: evidence || "",
    notes: notes || "",
    file: file || "",
    incompatible: incompatible === true,
  };
}

function knowledgeName(db, id) {
  const entry = modKnowledge.findById(db, id);
  return entry ? entry.name : id;
}

function nameToId(name, db) {
  const needle = String(name || "").trim().toLowerCase();
  const compact = needle.replace(/[^a-z0-9]+/g, "");
  const hit = ((db && db.mods) || []).find((m) => {
    const labels = [m.id, m.name, ...(m.aliases || [])].map((v) => String(v).toLowerCase());
    return labels.includes(needle) || labels.map((v) => v.replace(/[^a-z0-9]+/g, "")).includes(compact);
  });
  return hit ? hit.id : "";
}

function claimsFromKnowledge(recognition, db) {
  const entry =
    (recognition && recognition.knowledge) ||
    (recognition && recognition.modId && modKnowledge.findById(db, recognition.modId));
  if (!entry) return [];
  const out = [];
  for (const raw of entry.dependencies || []) {
    const dep = modKnowledge.normalizeDependency(raw);
    if (!dep) continue;
    out.push(
      claim({
        modId: dep.modId,
        name: knowledgeName(db, dep.modId),
        kind: dep.kind || "REQUIRED",
        source: "KNOWLEDGE_DATABASE",
        confidence: "HIGH",
        version: dep.version,
        notes: dep.notes,
        incompatible: dep.incompatible,
      })
    );
  }
  for (const raw of entry.optionalDependencies || []) {
    const dep = modKnowledge.normalizeDependency(
      typeof raw === "string" ? { modId: raw, kind: "OPTIONAL" } : { ...raw, kind: raw.kind || "OPTIONAL" }
    );
    if (!dep) continue;
    out.push(
      claim({
        modId: dep.modId,
        name: knowledgeName(db, dep.modId),
        kind: dep.kind || "OPTIONAL",
        source: "KNOWLEDGE_DATABASE",
        confidence: "HIGH",
        version: dep.version,
        notes: dep.notes,
        incompatible: dep.incompatible,
      })
    );
  }
  return out;
}

function claimsFromManifest(manifestDependencies, db) {
  return (manifestDependencies || []).map((dep) =>
    claim({
      modId: dep.modId || dep.id || dep.componentId || nameToId(dep.name, db),
      name: dep.name || knowledgeName(db, dep.modId || dep.id || dep.componentId),
      kind: dep.kind,
      source: "APP_MANIFEST",
      confidence: "HIGH",
      version: dep.version,
      notes: dep.notes,
      incompatible: dep.incompatible === true,
    })
  );
}

function claimsFromPackage(packageDeps, db) {
  const out = [];
  for (const dep of (packageDeps && packageDeps.dependencies) || []) {
    const id = dep.modId || nameToId(dep.name, db);
    out.push(
      claim({
        modId: id,
        name: dep.name || knowledgeName(db, id),
        kind:
          dep.kind ||
          (dep.level === "optional" ? "OPTIONAL" : dep.level === "recommended" ? "RECOMMENDED" : "REQUIRED"),
        source: "PACKAGE_METADATA",
        confidence: "HIGH",
        version: dep.version || "",
        evidence: dep.note || "",
      })
    );
  }
  return out;
}

function claimsFromReadme(readme) {
  return ((readme && readme.dependencies) || []).map((dep) =>
    claim({
      modId: dep.modId,
      name: dep.name,
      kind: dep.kind,
      source: "README",
      confidence: dep.confidence || "MEDIUM",
      version: dep.version,
      evidence: dep.evidence,
      file: dep.file,
    })
  );
}

function mergeClaims(groups) {
  const byKey = new Map();
  for (const item of groups.flat()) {
    const key = item.modId || `unknown:${String(item.name || "").toLowerCase()}`;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, {
        ...item,
        sources: item.source ? [item.source] : [],
        evidenceList: item.evidence ? [{ source: item.source, text: item.evidence, file: item.file || "" }] : [],
        evidenceConflict: false,
      });
      continue;
    }
    if (item.source && !current.sources.includes(item.source)) current.sources.push(item.source);
    if (item.evidence) current.evidenceList.push({ source: item.source, text: item.evidence, file: item.file || "" });
    if (
      item.kind &&
      current.kind &&
      item.kind !== current.kind &&
      item.kind !== "UNKNOWN" &&
      current.kind !== "UNKNOWN"
    ) {
      current.evidenceConflict = true;
    }
    if (
      item.version &&
      current.version &&
      item.version !== current.version &&
      item.version !== "UNKNOWN" &&
      current.version !== "UNKNOWN"
    ) {
      current.evidenceConflict = true;
    }
    if (item.incompatible) current.incompatible = true;
    if (rank(item.source) > rank(current.source)) {
      current.kind = item.kind;
      current.version = item.version || current.version;
      current.confidence = item.confidence;
      current.source = item.source;
      current.name = item.name || current.name;
      current.notes = item.notes || current.notes;
    } else if (!current.version && item.version) {
      current.version = item.version;
    }
  }
  return [...byKey.values()];
}

function knowledgeLabels(db, modId) {
  const entry = modKnowledge.findById(db, modId);
  return new Set(
    [modId, entry && entry.id, entry && entry.name, ...((entry && entry.aliases) || [])]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase())
  );
}

function knowledgeDlls(db, modId) {
  const entry = modKnowledge.findById(db, modId);
  return ((entry && entry.recognition && entry.recognition.dllNames) || []).map((n) => n.toLowerCase());
}

function collectParkedBasenames(dutyPath, dataDir) {
  const names = new Set();
  const walk = (root) => {
    if (!root || !exists(root)) return;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) names.add(entry.name.toLowerCase());
      }
    }
  };
  if (dutyPath) walk(path.join(tactixDir(dutyPath), "disabled"));
  if (dataDir) walk(path.join(dataDir, "disabled"));
  if (dataDir) {
    for (const mod of manifestStore.list(dataDir)) {
      if (mod.enabled !== false) continue;
      for (const file of mod.files || []) {
        names.add(path.basename(String(file.destination || file)).toLowerCase());
      }
    }
  }
  return names;
}

function lookupInventory(inventory, modId, db, parkedBasenames = new Set()) {
  if (!inventory || !modId) return null;
  const component = environmentInventory.findComponent(inventory, modId);
  if (component && component.state !== "MISSING") return component;
  const labels = knowledgeLabels(db, modId);
  const named = (inventory.components || []).find(
    (item) => item.id === modId || labels.has(String(item.name || "").toLowerCase())
  );
  if (named && named.state !== "MISSING") return named;
  const framework = (inventory.frameworks || []).find(
    (f) => f.id === modId || labels.has(String(f.name || "").toLowerCase())
  );
  if (framework) return framework;
  const managed = (inventory.managed || inventory.manifests || []).find(
    (m) => m.modId === modId || m.id === modId || labels.has(String(m.name || "").toLowerCase())
  );
  if (managed) {
    return {
      id: modId,
      name: managed.name || knowledgeName(db, modId),
      installed: true,
      enabled: managed.enabled !== false,
      state: managed.enabled === false ? "PARKED" : "INSTALLED",
      version: managed.version || "UNKNOWN",
    };
  }
  const dlls = knowledgeDlls(db, modId);
  const plugin = (inventory.plugins || []).find((p) => dlls.includes(String(p.name || "").toLowerCase()));
  if (plugin) {
    return {
      id: modId,
      name: plugin.name,
      installed: true,
      enabled: plugin.enabled !== false,
      state: plugin.enabled === false ? "PARKED" : "INSTALLED",
      version: plugin.version || "UNKNOWN",
    };
  }
  const extraParked = inventory.parkedBasenames || parkedBasenames;
  const parkedHas = (name) =>
    (extraParked && typeof extraParked.has === "function" && extraParked.has(name)) ||
    (Array.isArray(extraParked) && extraParked.includes(name));
  if (dlls.some((name) => parkedHas(name))) {
    return {
      id: modId,
      name: knowledgeName(db, modId),
      installed: true,
      enabled: false,
      state: "PARKED",
      version: "UNKNOWN",
    };
  }
  return component && component.state === "MISSING" ? component : null;
}

function bundledFile(modId, db, packFiles) {
  const entry = modKnowledge.findById(db, modId);
  const names = new Set(((entry && entry.recognition && entry.recognition.dllNames) || []).map((n) => n.toLowerCase()));
  return (packFiles || []).find((file) => names.has(path.basename(String(file.source || file.rel || file.destination || file)).toLowerCase())) || null;
}

function detectBundledVersion(file) {
  if (file && file.version && file.version !== "UNKNOWN") return file.version;
  const abs = file && (file.sourceAbs || file.abs);
  if (!abs) return "UNKNOWN";
  return versionDetector.detectFileVersion(abs).version;
}

function resolveState(found, requirement, bundled, bundledVersion, { incompatible = false } = {}) {
  if (bundled) {
    return { state: "BUNDLED", installedVersion: found && found.installed ? found.version || "UNKNOWN" : "UNKNOWN", bundledVersion };
  }
  if (found && (found.state === "PARKED" || found.enabled === false) && found.installed) {
    return { state: "DISABLED", installedVersion: found.version || "UNKNOWN", bundledVersion: "UNKNOWN" };
  }
  if (!found || found.state === "MISSING" || !found.installed) {
    if (incompatible) {
      return { state: "INCOMPATIBLE", installedVersion: "UNKNOWN", bundledVersion: "UNKNOWN" };
    }
    return { state: "MISSING", installedVersion: "UNKNOWN", bundledVersion: "UNKNOWN" };
  }
  const installedVersion = found.version || "UNKNOWN";
  if (!requirement || requirement === "UNKNOWN") {
    return { state: "INSTALLED", installedVersion, bundledVersion: "UNKNOWN" };
  }
  const check = versionDetector.satisfiesVersion(installedVersion, requirement);
  if (check.status === "TOO_OLD") return { state: "VERSION_TOO_OLD", installedVersion, bundledVersion: "UNKNOWN", versionCheck: check };
  if (check.status === "TOO_NEW") return { state: "VERSION_TOO_NEW", installedVersion, bundledVersion: "UNKNOWN", versionCheck: check };
  if (check.status === "UNKNOWN" || check.status === "INVALID_REQUIREMENT") {
    return { state: "UNKNOWN", installedVersion, bundledVersion: "UNKNOWN", versionCheck: check };
  }
  return { state: "INSTALLED", installedVersion, bundledVersion: "UNKNOWN", versionCheck: check };
}

function explain(dep, resolved) {
  if (resolved.state === "BUNDLED") {
    return `${dep.name} is included in this package${resolved.bundledVersion && resolved.bundledVersion !== "UNKNOWN" ? ` (${resolved.bundledVersion})` : ""}.`;
  }
  if (resolved.state === "INSTALLED") {
    return `${dep.name} is installed${resolved.installedVersion && resolved.installedVersion !== "UNKNOWN" ? `: ${resolved.installedVersion}` : ""}.`;
  }
  if (resolved.state === "MISSING") {
    return `${dep.name} is ${String(dep.kind).toLowerCase()} and was not detected in the LSPDFR folder.`;
  }
  if (resolved.state === "DISABLED") {
    return `${dep.name} is installed but currently parked/disabled. The manager will not re-enable it automatically.`;
  }
  if (resolved.state === "VERSION_TOO_OLD") {
    return `${dep.name} ${resolved.installedVersion} does not satisfy ${dep.version}.`;
  }
  if (resolved.state === "VERSION_TOO_NEW") {
    return `${dep.name} ${resolved.installedVersion} is newer than the stated requirement ${dep.version}.`;
  }
  if (resolved.state === "INCOMPATIBLE") {
    return `${dep.name} is marked incompatible by dependency metadata.`;
  }
  return `${dep.name} was mentioned, but its install state or version is UNKNOWN.`;
}

function summarize(dependencies) {
  const required = dependencies.filter((d) => d.kind === "REQUIRED");
  const satisfied = required.filter((d) => d.state === "INSTALLED" || d.state === "BUNDLED");
  const missing = required.filter((d) => d.state === "MISSING");
  const disabled = required.filter((d) => d.state === "DISABLED");
  const optionalMissing = dependencies.filter((d) => (d.kind === "OPTIONAL" || d.kind === "RECOMMENDED") && d.state === "MISSING");
  return {
    requiredTotal: required.length,
    requiredSatisfied: satisfied.length,
    requiredMissing: missing.length,
    requiredDisabled: disabled.length,
    optionalMissing: optionalMissing.length,
    hasBlockingDependencyIssue: missing.length > 0 || disabled.length > 0,
  };
}

function resolve({
  recognition = null,
  dutyPath = "",
  dataDir = "",
  inventory = null,
  packFiles = [],
  readme = null,
  packageDeps = null,
  manifestDependencies = [],
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
  const parkedBasenames = inventory
    ? new Set(inventory.parkedBasenames || [])
    : collectParkedBasenames(dutyPath, dataDir);

  const merged = mergeClaims([
    claimsFromManifest(manifestDependencies, db),
    claimsFromKnowledge(recognition, db),
    claimsFromPackage(packageDeps, db),
    claimsFromReadme(readme),
  ]);

  const dependencies = merged.map((dep) => {
    const found = lookupInventory(env, dep.modId, db, parkedBasenames);
    const packFile = bundledFile(dep.modId, db, packFiles);
    const bundledVersion = packFile ? detectBundledVersion(packFile) : "UNKNOWN";
    const resolved = resolveState(found, dep.version, Boolean(packFile), bundledVersion, {
      incompatible: dep.incompatible === true,
    });
    return {
      modId: dep.modId,
      name: dep.name,
      kind: dep.kind,
      state: resolved.state,
      installedVersion: resolved.installedVersion,
      bundledVersion: resolved.bundledVersion,
      requiredVersion: dep.version || "UNKNOWN",
      source: dep.source,
      sources: dep.sources || [dep.source],
      confidence: dep.confidence,
      evidenceConflict: Boolean(dep.evidenceConflict),
      evidenceList: dep.evidenceList || [],
      destination: packFile ? packFile.destination || packFile.source || "" : "",
      fileConflict: Boolean(packFile && found && found.installed),
      message: explain(dep, resolved),
    };
  });

  return {
    dependencies,
    summary: summarize(dependencies),
  };
}

module.exports = {
  resolve,
  mergeClaims,
  summarize,
  nameToId,
  SOURCE_RANK,
};
