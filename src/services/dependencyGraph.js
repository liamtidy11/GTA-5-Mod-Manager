// Simple dependency graph over currently managed mods. Reuses built-in/user
// knowledge to relate mods to the components they need and provide. It does
// not download, install, or remove anything.

function knowledgeById(database) {
  const map = new Map();
  for (const entry of (database && database.mods) || []) map.set(entry.id, entry);
  return map;
}

function dependencyTargets(database) {
  const targets = new Set();
  for (const entry of (database && database.mods) || []) {
    for (const dep of [...(entry.dependencies || []), ...(entry.optionalDependencies || [])]) {
      if (dep && dep.componentId) targets.add(dep.componentId);
    }
  }
  return targets;
}

function build({ mods = [], database = { mods: [] } } = {}) {
  const byId = knowledgeById(database);
  const nodes = mods.map((mod) => ({
    installId: mod.id || mod.installId,
    name: mod.name || "Mod",
    canonicalModId: mod.canonicalModId || mod.recognitionModId || null,
    category: mod.category || (byId.get(mod.canonicalModId) || {}).category || "UNKNOWN",
    enabled: mod.enabled !== false,
  }));

  // component id -> installId that provides it
  const providerByComponent = new Map();
  for (const node of nodes) {
    if (node.canonicalModId) providerByComponent.set(node.canonicalModId, node.installId);
  }

  const forward = new Map(); // installId -> [{ componentId, kind, name, satisfiedByInstallId, installed }]
  const inverse = new Map(); // installId (provider) -> [{ installId, name, kind }]
  for (const node of nodes) forward.set(node.installId, []);
  for (const node of nodes) inverse.set(node.installId, []);

  for (const node of nodes) {
    const entry = node.canonicalModId ? byId.get(node.canonicalModId) : null;
    if (!entry) continue;
    const deps = [...(entry.dependencies || []), ...(entry.optionalDependencies || [])];
    for (const dep of deps) {
      const providerId = providerByComponent.get(dep.componentId);
      const label = (byId.get(dep.componentId) || {}).name || dep.componentId;
      forward.get(node.installId).push({
        componentId: dep.componentId,
        kind: dep.kind || "REQUIRED",
        name: label,
        satisfiedByInstallId: providerId || null,
        installed: Boolean(providerId),
      });
      if (providerId) {
        inverse.get(providerId).push({ installId: node.installId, name: node.name, kind: dep.kind || "REQUIRED" });
      }
    }
  }

  return { nodes, forward, inverse, providerByComponent, dependencyTargets: dependencyTargets(database) };
}

function forwardTree(graph, installId) {
  const node = graph.nodes.find((n) => n.installId === installId);
  if (!node) return null;
  return {
    installId,
    name: node.name,
    dependencies: (graph.forward.get(installId) || []).map((dep) => ({ ...dep })),
  };
}

// Mods that depend on the component this mod provides.
function impactOfDisabling(graph, installId) {
  return (graph.inverse.get(installId) || []).map((row) => ({ ...row }));
}

function requiredDependents(graph, installId) {
  return impactOfDisabling(graph, installId).filter((row) => row.kind === "REQUIRED");
}

// Dependencies (libraries) installed but not required by any installed mod.
function orphans(graph) {
  const out = [];
  for (const node of graph.nodes) {
    if (!node.canonicalModId) continue;
    if (!graph.dependencyTargets.has(node.canonicalModId)) continue; // only things that are dependency targets
    const dependents = graph.inverse.get(node.installId) || [];
    if (dependents.length === 0) {
      out.push({ installId: node.installId, name: node.name, canonicalModId: node.canonicalModId });
    }
  }
  return out;
}

module.exports = {
  build,
  forwardTree,
  impactOfDisabling,
  requiredDependents,
  orphans,
  dependencyTargets,
};
