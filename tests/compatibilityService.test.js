const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, makeFakeDuty, cleanup } = require("./helpers");
const modKnowledge = require("../src/services/modKnowledge");
const compatibilityService = require("../src/services/compatibilityService");
const recommendationEngine = require("../src/services/recommendationEngine");
const smartInstall = require("../src/services/smartInstall");
const health = require("../src/services/health");

function inventory(overrides = {}) {
  return {
    components: [
      { id: "gta-enhanced", installed: true, enabled: true, state: "INSTALLED", version: "1.0.1158.13" },
      { id: "lspdfr", installed: true, enabled: true, state: "INSTALLED", version: "0.4.9" },
      { id: "rage-plugin-hook", installed: true, enabled: true, state: "INSTALLED", version: "1.131" },
    ],
    frameworks: [],
    plugins: [],
    lspdfr: { version: "0.4.9" },
    ragePluginHook: { version: "1.131" },
    gta: { version: "1.0.1158.13" },
    ...overrides,
  };
}

function knowledge(partial) {
  return modKnowledge.parseDatabase(
    {
      schemaVersion: 1,
      mods: [
        {
          id: "sample-mod",
          name: "Sample Mod",
          aliases: [],
          category: "LSPDFR_PLUGIN",
          recognition: { dllNames: ["Sample.dll"] },
          dependencies: [],
          optionalDependencies: [],
          conflicts: [],
          incompatibleWith: [],
          compatibility: { gtaEnhanced: "UNKNOWN", lspdfr: {}, ragePluginHook: {} },
          ...partial,
        },
      ],
    },
    "TEST"
  );
}

function evaluate(opts) {
  return compatibilityService.evaluate({
    inventory: inventory(),
    database: knowledge({}),
    recognition: { modId: "sample-mod" },
    dependencies: [],
    installedMods: [],
    ...opts,
  });
}

test("verified Enhanced compatibility", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "VERIFIED" } }),
  });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.findings.find((f) => f.code === "GTA_ENHANCED").status, "VERIFIED");
});

test("likely compatibility", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY" } }),
    dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", state: "INSTALLED", installedVersion: "1.9.1" }],
  });
  assert.equal(result.status, "LIKELY_COMPATIBLE");
});

test("unknown compatibility", () => {
  const result = evaluate({});
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.findings.find((f) => f.code === "GTA_ENHANCED").status, "UNKNOWN");
});

test("known Enhanced incompatibility", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "INCOMPATIBLE" } }),
  });
  assert.equal(result.status, "INCOMPATIBLE");
  assert.match(result.findings.find((f) => f.code === "GTA_ENHANCED").message, /should not be used/i);
});

test("LSPDFR minimum satisfied", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", lspdfr: { min: "0.4.9" } } }),
  });
  const hit = result.findings.find((f) => f.code === "LSPDFR_VERSION_OK");
  assert.ok(hit);
  assert.match(hit.message, /0\.4\.9/);
});

test("LSPDFR too old", () => {
  const result = evaluate({
    inventory: inventory({
      components: [
        { id: "lspdfr", installed: true, enabled: true, state: "INSTALLED", version: "0.4.8" },
        { id: "rage-plugin-hook", installed: true, enabled: true, state: "INSTALLED", version: "1.131" },
      ],
      lspdfr: { version: "0.4.8" },
    }),
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", lspdfr: { min: "0.4.9" } } }),
  });
  assert.equal(result.findings.find((f) => f.code === "LSPDFR_VERSION").status, "WARNING");
  assert.equal(result.status, "WARNING");
});

test("LSPDFR unknown version", () => {
  const result = evaluate({
    inventory: inventory({
      components: [{ id: "lspdfr", installed: true, enabled: true, state: "INSTALLED", version: "UNKNOWN" }],
      lspdfr: { version: "UNKNOWN" },
    }),
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", lspdfr: { requirement: ">= 0.4.9" } } }),
  });
  const hit = result.findings.find((f) => f.code === "LSPDFR_VERSION_UNKNOWN");
  assert.ok(hit);
  assert.equal(hit.status, "UNKNOWN");
  assert.notEqual(result.status, "INCOMPATIBLE");
});

test("RPH minimum satisfied", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", ragePluginHook: { min: "1.130" } } }),
  });
  assert.ok(result.findings.some((f) => f.code === "RPH_VERSION_OK"));
});

test("RPH too old", () => {
  const result = evaluate({
    inventory: inventory({
      components: [{ id: "rage-plugin-hook", installed: true, enabled: true, state: "INSTALLED", version: "1.100" }],
      ragePluginHook: { version: "1.100" },
    }),
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", ragePluginHook: { min: "1.130" } } }),
  });
  assert.equal(result.findings.find((f) => f.code === "RPH_VERSION").status, "WARNING");
});

test("RPH unknown version", () => {
  const result = evaluate({
    inventory: inventory({
      components: [{ id: "rage-plugin-hook", installed: true, enabled: true, state: "INSTALLED", version: "UNKNOWN" }],
      ragePluginHook: { version: "UNKNOWN" },
    }),
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY", ragePluginHook: { exact: "1.131" } } }),
  });
  assert.equal(result.findings.find((f) => f.code === "RPH_VERSION_UNKNOWN").status, "UNKNOWN");
});

test("required dependency installed", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY" } }),
    dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", state: "INSTALLED" }],
  });
  assert.ok(result.findings.some((f) => f.code === "REQUIRED_DEPENDENCY_OK"));
});

test("required dependency missing", () => {
  const result = evaluate({
    dependencies: [{ modId: "lemonui", name: "LemonUI", kind: "REQUIRED", state: "MISSING" }],
  });
  const hit = result.findings.find((f) => f.code === "REQUIRED_DEPENDENCY_MISSING");
  assert.ok(hit);
  assert.match(hit.message, /LemonUI/);
  assert.equal(result.status, "WARNING");
});

test("required dependency disabled", () => {
  const result = evaluate({
    dependencies: [{ modId: "scripthookvdotnet", name: "Script Hook V .NET", kind: "REQUIRED", state: "DISABLED" }],
  });
  assert.ok(result.findings.some((f) => f.code === "REQUIRED_DEPENDENCY_DISABLED"));
  assert.equal(result.status, "WARNING");
});

test("required dependency too old", () => {
  const result = evaluate({
    dependencies: [
      {
        modId: "lemonui",
        name: "LemonUI",
        kind: "REQUIRED",
        state: "VERSION_TOO_OLD",
        installedVersion: "1.8.0",
        requiredVersion: ">= 1.9.0",
      },
    ],
  });
  const hit = result.findings.find((f) => f.code === "REQUIRED_DEPENDENCY_TOO_OLD");
  assert.match(hit.message, /1\.8\.0/);
  assert.match(hit.message, /1\.9\.0/);
});

test("optional dependency missing", () => {
  const result = evaluate({
    database: knowledge({ compatibility: { gtaEnhanced: "LIKELY" } }),
    dependencies: [{ modId: "stop-the-ped", name: "Stop The Ped", kind: "OPTIONAL", state: "MISSING" }],
  });
  assert.ok(result.findings.some((f) => f.code === "OPTIONAL_DEPENDENCY_MISSING"));
  assert.notEqual(result.status, "INCOMPATIBLE");
});

test("logical mod conflict", () => {
  const result = evaluate({
    database: knowledge({
      compatibility: { gtaEnhanced: "LIKELY" },
      conflicts: [{ modId: "other-mod", severity: "HIGH", reason: "Both plugins replace the same policing subsystem." }],
    }),
    installedMods: [{ modId: "other-mod", name: "Other Mod", enabled: true }],
  });
  const hit = result.findings.find((f) => f.code === "LOGICAL_CONFLICT");
  assert.ok(hit);
  assert.match(hit.message, /policing subsystem/);
  assert.equal(result.status, "WARNING");
});

test("parked conflicting mod", () => {
  const result = evaluate({
    database: knowledge({
      compatibility: { gtaEnhanced: "LIKELY" },
      conflicts: [{ modId: "other-mod", severity: "HIGH", reason: "Overlap." }],
    }),
    installedMods: [{ modId: "other-mod", name: "Other Mod", enabled: false }],
  });
  assert.ok(result.findings.some((f) => f.code === "PARKED_CONFLICT"));
  assert.equal(result.findings.some((f) => f.code === "LOGICAL_CONFLICT"), false);
});

test("local environment warning", () => {
  const result = evaluate({
    dependencies: [{ modId: "scripthookvdotnet", name: "Script Hook V .NET", kind: "REQUIRED", state: "DISABLED" }],
  });
  const local = result.findings.find((f) => f.code === "LOCAL_ENVIRONMENT_WARNING");
  assert.ok(local);
  assert.match(local.message, /disabled in this Duty profile/i);
  assert.doesNotMatch(local.message, /never works/i);
});

test("unknown evidence stays unknown", () => {
  const result = evaluate({
    dependencies: [
      { modId: "lemonui", name: "LemonUI", kind: "REQUIRED", state: "UNKNOWN", requiredVersion: ">= 1.9.0" },
    ],
  });
  assert.equal(result.findings.find((f) => f.code === "REQUIRED_DEPENDENCY_VERSION_UNKNOWN").status, "UNKNOWN");
  assert.notEqual(result.status, "INCOMPATIBLE");
});

function reco(partial) {
  return recommendationEngine.recommend({
    compatibility: { status: "LIKELY_COMPATIBLE", findings: [] },
    installSafety: { status: "SAFE", findings: [{ code: "ROLLBACK_AVAILABLE", status: "SAFE", message: "Rollback is available." }] },
    dependencies: [{ kind: "REQUIRED", state: "INSTALLED", sources: ["KNOWLEDGE_DATABASE"] }],
    recognition: { band: "HIGH", modId: "sample-mod" },
    duplicate: {},
    ...partial,
  });
}

test("safe to install", () => {
  const result = reco({});
  assert.equal(result.status, "SAFE_TO_INSTALL");
  assert.ok(result.reasons.length);
});

test("install with warning", () => {
  const result = reco({
    compatibility: {
      status: "UNKNOWN",
      findings: [{ code: "GTA_ENHANCED", status: "UNKNOWN", message: "GTA V Enhanced compatibility has not been verified for this mod." }],
    },
  });
  assert.equal(result.status, "INSTALL_WITH_WARNING");
});

test("not recommended", () => {
  const result = reco({
    dependencies: [{ kind: "REQUIRED", state: "MISSING", name: "LemonUI" }],
    compatibility: {
      status: "WARNING",
      findings: [{ code: "REQUIRED_DEPENDENCY_MISSING", severity: "HIGH", status: "WARNING", message: "LemonUI is required and was not detected in the LSPDFR folder." }],
    },
  });
  assert.equal(result.status, "NOT_RECOMMENDED");
  assert.equal(result.allowOverride, true);
});

test("blocked", () => {
  const result = reco({
    installSafety: {
      status: "BLOCKED",
      findings: [{ status: "BLOCKED", message: "The install target is the clean Online install." }],
    },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.allowOverride, false);
});

test("unknown compatibility does not automatically block", () => {
  const result = reco({
    compatibility: { status: "UNKNOWN", findings: [{ code: "GTA_ENHANCED", status: "UNKNOWN", message: "Unknown Enhanced support." }] },
  });
  assert.notEqual(result.status, "BLOCKED");
});

test("optional dependency missing does not block", () => {
  const result = reco({
    dependencies: [{ kind: "OPTIONAL", state: "MISSING", name: "Stop The Ped" }],
    compatibility: {
      status: "LIKELY_COMPATIBLE",
      findings: [{ code: "OPTIONAL_DEPENDENCY_MISSING", status: "UNKNOWN", message: "Stop The Ped is optional and is not installed." }],
    },
  });
  assert.notEqual(result.status, "BLOCKED");
  assert.notEqual(result.status, "NOT_RECOMMENDED");
});

test("required dependency missing => not recommended", () => {
  const result = reco({
    dependencies: [{ kind: "REQUIRED", state: "MISSING" }],
    compatibility: { status: "WARNING", findings: [{ code: "REQUIRED_DEPENDENCY_MISSING", severity: "HIGH", message: "Missing LemonUI" }] },
  });
  assert.equal(result.status, "NOT_RECOMMENDED");
});

test("required dependency disabled => not recommended", () => {
  const result = reco({
    dependencies: [{ kind: "REQUIRED", state: "DISABLED" }],
    compatibility: { status: "WARNING", findings: [{ code: "REQUIRED_DEPENDENCY_DISABLED", severity: "HIGH", message: "Script Hook V .NET is required but currently disabled." }] },
  });
  assert.equal(result.status, "NOT_RECOMMENDED");
});

test("protected file => blocked", () => {
  const safety = recommendationEngine.evaluateInstallSafety({
    conflicts: {
      severity: "BLOCKED",
      items: [{ level: "BLOCKED", code: "online-target", message: "The install target is the clean Online install. Smart Install never writes there." }],
    },
    files: [{ action: "add" }],
    rollbackAvailable: true,
  });
  assert.equal(safety.status, "BLOCKED");
  const result = reco({ installSafety: safety });
  assert.equal(result.status, "BLOCKED");
});

test("path traversal => blocked", () => {
  const safety = recommendationEngine.evaluateInstallSafety({
    security: { ok: false, traversal: ["../evil.dll"], executables: [] },
    files: [{ action: "add" }],
  });
  assert.ok(safety.findings.some((f) => f.code === "PATH_TRAVERSAL"));
  assert.equal(safety.status, "BLOCKED");
  assert.equal(reco({ installSafety: safety }).status, "BLOCKED");
});

test("no rollback => blocked", () => {
  const safety = recommendationEngine.evaluateInstallSafety({
    files: [{ action: "add" }],
    rollbackAvailable: false,
  });
  assert.equal(safety.status, "BLOCKED");
  assert.ok(safety.findings.some((f) => f.code === "NO_ROLLBACK"));
});

test("known incompatibility => not recommended", () => {
  const result = reco({
    compatibility: {
      status: "INCOMPATIBLE",
      findings: [{ status: "INCOMPATIBLE", code: "GTA_ENHANCED", message: "Trusted data says this mod should not be used with GTA V Enhanced." }],
    },
  });
  assert.equal(result.status, "NOT_RECOMMENDED");
  assert.notEqual(result.status, "BLOCKED");
});

test("Smart Install analysis includes compatibility, safety, and recommendation", async () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Callout.dll", "CALLOUT");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.ok(preview.compatibility && preview.compatibility.status);
    assert.ok(Array.isArray(preview.compatibility.findings));
    assert.ok(preview.installSafety && preview.installSafety.status);
    assert.ok(preview.recommendation && preview.recommendation.status);
    assert.ok(preview.recommendation.reasons.length);
    assert.notEqual(preview.recommendation.status, "BLOCKED");
    assert.notEqual(preview.conflicts.severity, "BLOCKED");
    const dll = preview.files.find((f) => f.destination.endsWith("Callout.dll"));
    assert.equal(dll.action, "add");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("Duty Health compatibility summary is informational for unknowns", () => {
  const dataDir = tmpDir("data-");
  const fs = require("fs");
  const path = require("path");
  fs.mkdirSync(path.join(dataDir, "manifests"), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "manifests", "a.json"),
    JSON.stringify({ id: "a", enabled: true, files: [], compatibilityStatus: "UNKNOWN", name: "A" })
  );
  fs.writeFileSync(
    path.join(dataDir, "manifests", "b.json"),
    JSON.stringify({ id: "b", enabled: true, files: [], compatibilityStatus: "LIKELY_COMPATIBLE", name: "B" })
  );
  try {
    const row = health.summarizeModCompatibility(dataDir);
    assert.equal(row.ok, true);
    assert.equal(row.level, "ok");
    assert.match(row.detail, /unknown/i);
    assert.match(row.detail, /likely\/verified/);
  } finally {
    cleanup(dataDir);
  }
});
