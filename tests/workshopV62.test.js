const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const { loadCatalog, validateCatalog } = require("../src/services/workshop/catalog");
const { isAllowedSourceUrl } = require("../src/services/workshop/providers/providerTypes");
const { createLocalCatalogProvider, matchesQuery } = require("../src/services/workshop/providers/localCatalogProvider");
const { createLcpdfrProvider, apiStatus, smokeMetadata } = require("../src/services/workshop/providers/lcpdfrProvider");
const { createSecretStore, memoryCipher } = require("../src/services/workshop/secretStore");
const { writeCache, readCache } = require("../src/services/workshop/workshopCache");
const library = require("../src/services/workshop/userLibrary");
const inbox = require("../src/services/workshop/downloadInbox");
const { filterMods, search } = require("../src/services/workshop/workshopSearch");
const { installedState, updateAvailable } = require("../src/services/workshop/installedMatch");
const { buildHandoff, evaluateHandoff } = require("../src/services/workshop/handoff");
const workshop = require("../src/services/workshop/workshopService");

const DATABASE = {
  mods: [
    {
      id: "policing-redefined",
      name: "Policing Redefined",
      compatibility: { gtaEnhanced: "UNKNOWN" },
      dependencies: [
        { modId: "ragenativeui", kind: "REQUIRED" },
        { modId: "damage-tracker-framework", kind: "REQUIRED" },
      ],
      conflicts: [{ modId: "stop-the-ped", reason: "Usually not used together." }],
    },
    { id: "ragenativeui", name: "RAGENativeUI", compatibility: { gtaEnhanced: "UNKNOWN" }, dependencies: [] },
    { id: "damage-tracker-framework", name: "Damage Tracker Framework", compatibility: { gtaEnhanced: "UNKNOWN" }, dependencies: [] },
    { id: "stop-the-ped", name: "Stop The Ped", compatibility: { gtaEnhanced: "UNKNOWN" }, dependencies: [] },
  ],
};

function testCatalog(root) {
  const file = path.join(root, "catalog.json");
  const raw = {
    schemaVersion: 1,
    essentials: ["ragenativeui"],
    mods: [
      {
        id: "policing-redefined",
        name: "Policing Redefined",
        category: "POLICE_INTERACTION",
        source: "LCPDFR",
        sourceUrl: "https://www.lcpdfr.com/downloads/gta5mods/scripts/52191-policing-redefined/",
        canonicalModId: "policing-redefined",
        description: "Police interaction",
        tags: ["plugin"],
        aliases: ["PR"],
        dllNames: ["PolicingRedefined.dll"],
        featured: true,
        enhanced: "VERIFIED",
      },
      {
        id: "ragenativeui",
        name: "RAGENativeUI",
        category: "FRAMEWORK",
        source: "GITHUB",
        sourceUrl: "https://github.com/alexguirre/RAGENativeUI/releases/latest",
        canonicalModId: "ragenativeui",
        aliases: ["RNUI"],
        dllNames: ["RAGENativeUI.dll"],
        sourceVersion: "1.9.3",
      },
      {
        id: "future-cars",
        name: "Future Cars",
        category: "VEHICLE",
        source: "LCPDFR",
        sourceUrl: "https://www.lcpdfr.com/downloads/gta5mods/vehiclemodels/1-example/",
        canonicalModId: "future-cars",
        description: "Cars",
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return file;
}

function ctx(root, extras = {}) {
  return workshop.createContext({
    userData: root,
    workshopRoot: path.join(root, "workshop"),
    catalogPath: extras.catalogPath || testCatalog(root),
    mods: extras.mods || [],
    inventory: extras.inventory || null,
    database: extras.database || DATABASE,
    downloadDir: extras.downloadDir || path.join(root, "downloads"),
    watchDownloads: extras.watchDownloads === true,
    apiKey: extras.apiKey || "",
    offline: extras.offline === true,
    providerNotice: extras.providerNotice || "",
    cacheRetentionHours: extras.cacheRetentionHours || 24,
  });
}

test("bundled catalog loads and validates", () => {
  const loaded = loadCatalog();
  assert.equal(loaded.ok, true);
  assert.ok(loaded.catalog.mods.length >= 8);
  assert.ok(loaded.catalog.mods.every((row) => isAllowedSourceUrl(row.sourceUrl)));
  const checked = validateCatalog(JSON.parse(fs.readFileSync(require("../src/services/workshop/catalog").DEFAULT_PATH, "utf8")));
  assert.equal(checked.ok, true);
});

test("catalog schema rejects a missing official URL", () => {
  const checked = validateCatalog({
    mods: [{ id: "x", name: "X", category: "OTHER", sourceUrl: "http://example.com" }],
  });
  assert.equal(checked.ok, false);
});

test("search and category filtering", () => {
  const root = tmpDir("ws-search-");
  const data = workshop.browse(ctx(root));
  const pr = search(data.all, "policing redefined");
  assert.equal(pr[0].canonicalModId, "policing-redefined");
  const frameworks = filterMods(data.all, { filter: "FRAMEWORKS" });
  assert.ok(frameworks.every((row) => row.category === "FRAMEWORK"));
  const plugins = filterMods(data.all, { filter: "PLUGINS" });
  assert.ok(plugins.some((row) => row.canonicalModId === "policing-redefined"));
  cleanup(root);
});

test("favorites and collections stay local", () => {
  const root = tmpDir("ws-lib-");
  const ws = path.join(root, "workshop");
  library.toggleFavorite(ws, "local:policing-redefined");
  assert.equal(library.isFavorite(ws, "local:policing-redefined"), true);
  const created = library.createCollection(ws, "My Essentials");
  library.addToCollection(ws, created.collections[0].id, "local:policing-redefined");
  assert.deepEqual(library.load(ws).collections[0].workshopIds, ["local:policing-redefined"]);
  cleanup(root);
});

test("provider unavailable and cache fallback keep local results", () => {
  const root = tmpDir("ws-off-");
  writeCache(path.join(root, "workshop"), { provider: "LCPDFR", payload: { ids: ["x"] }, now: "2026-01-01T00:00:00.000Z" });
  const cached = readCache(path.join(root, "workshop"), { ttlMs: 1000, nowMs: Date.parse("2026-01-02T00:00:00.000Z") });
  assert.equal(cached.stale, true);
  const page = workshop.browse(
    ctx(root, { offline: true, providerNotice: "LCPDFR catalog unavailable. Showing cached/local results." })
  );
  assert.match(page.notice, /unavailable/i);
  assert.ok(page.mods.length);
  cleanup(root);
});

test("installed match, version comparison, and update available", () => {
  const entry = { canonicalModId: "ragenativeui", id: "ragenativeui", aliases: [], sourceVersion: "1.9.3" };
  const state = installedState(entry, {
    mods: [{ id: "rnui-1", canonicalModId: "ragenativeui", name: "RAGENativeUI", version: "1.8.0" }],
    sourceVersion: "1.9.3",
  });
  assert.equal(state.installed, true);
  assert.equal(state.installedVersion, "1.8.0");
  assert.equal(state.sourceVersion, "1.9.3");
  assert.equal(state.updateAvailable, true);
  assert.equal(updateAvailable("1.9.3", "1.9.3"), false);
});

test("dependency status uses local knowledge, not catalog Enhanced text", () => {
  const root = tmpDir("ws-dep-");
  const page = workshop.browse(
    ctx(root, {
      mods: [{ id: "rnui-1", canonicalModId: "ragenativeui", name: "RAGENativeUI", version: "1.9.3" }],
    })
  );
  const pr = page.all.find((row) => row.canonicalModId === "policing-redefined");
  assert.equal(pr.enhancedCompatibility, "UNKNOWN");
  assert.equal(pr.catalogEnhanced, "VERIFIED");
  const rnui = pr.dependencies.find((dep) => dep.componentId === "ragenativeui");
  const dtf = pr.dependencies.find((dep) => dep.componentId === "damage-tracker-framework");
  assert.equal(rnui.installed, true);
  assert.equal(dtf.installed, false);
  assert.ok(pr.installOrder[0].name.includes("Damage Tracker") || pr.installOrder.some((row) => /Damage/.test(row.name)));
  cleanup(root);
});

test("official source URL allow-list", () => {
  assert.equal(isAllowedSourceUrl("https://www.lcpdfr.com/downloads/gta5mods/scripts/52191-policing-redefined/"), true);
  assert.equal(isAllowedSourceUrl("https://evil.example/mod.zip"), false);
  assert.equal(isAllowedSourceUrl("http://www.lcpdfr.com/x"), false);
});

test("expected package handoff match, mismatch, and weak recognition", () => {
  const expected = buildHandoff({ workshopId: "local:pr", canonicalModId: "policing-redefined", name: "Policing Redefined", provider: "LCPDFR" });
  const match = evaluateHandoff({
    expected,
    preview: { recognition: { modId: "policing-redefined", name: "Policing Redefined", confidence: 0.97, band: "HIGH" } },
  });
  assert.equal(match.status, "MATCH");
  const mismatch = evaluateHandoff({
    expected,
    preview: { recognition: { modId: "stop-the-ped", name: "Stop The Ped", confidence: 0.9, band: "HIGH" } },
  });
  assert.equal(mismatch.mismatch, true);
  assert.match(mismatch.message, /DOES NOT MATCH/i);
  const unknown = evaluateHandoff({
    expected,
    preview: { recognition: { confidence: 0.2, band: "UNKNOWN" }, name: "pack.zip" },
  });
  assert.equal(unknown.weak, true);
});

test("vehicle unsupported state stays honest", () => {
  const root = tmpDir("ws-car-");
  const page = workshop.browse(ctx(root));
  const cars = page.all.find((row) => row.canonicalModId === "future-cars");
  assert.equal(cars.archiveInstallUnsupported, true);
  assert.equal(["VERIFIED", "LIKELY"].includes(cars.enhancedCompatibility), false);
  cleanup(root);
});

test("unknown Enhanced state is not upgraded from catalog text", () => {
  const root = tmpDir("ws-enh-");
  const details = workshop.details(ctx(root), "policing-redefined");
  assert.equal(details.enhancedCompatibility, "UNKNOWN");
  assert.equal(details.enhancedLabel, "Unknown");
  cleanup(root);
});

test("API key missing and capability handling", () => {
  const missing = apiStatus({ apiKey: "" });
  assert.equal(missing.configured, false);
  assert.equal(missing.canDirectDownload, false);
  const ready = apiStatus({ apiKey: "user-key" });
  assert.equal(ready.configured, true);
  assert.equal(ready.canList, false);
  assert.equal(ready.canDirectDownload, false);
  const provider = createLcpdfrProvider({ apiKey: "user-key" });
  assert.equal(provider.canDirectDownload, false);
  assert.equal(smokeMetadata({ apiKey: "" }).reason, "API_KEY_MISSING");
  assert.equal(smokeMetadata({ apiKey: "user-key" }).requested, false);
});

test("secret store never keeps a plaintext key helper", () => {
  const root = tmpDir("ws-sec-");
  const store = createSecretStore(root, memoryCipher());
  store.setLcpdfrKey("super-secret");
  const disk = fs.readFileSync(path.join(root, "secrets.json"), "utf8");
  assert.equal(disk.includes("super-secret"), false);
  assert.equal(store.getLcpdfrKey(), "super-secret");
  cleanup(root);
});

test("rate-limit caching marks stale payloads", () => {
  const root = tmpDir("ws-cache-");
  writeCache(root, { now: "2026-09-13T00:00:00.000Z" });
  const fresh = readCache(root, { ttlMs: 60 * 60 * 1000, nowMs: Date.parse("2026-09-13T00:10:00.000Z") });
  assert.equal(fresh.stale, false);
  const stale = readCache(root, { ttlMs: 1000, nowMs: Date.parse("2026-09-13T01:00:00.000Z") });
  assert.equal(stale.stale, true);
  cleanup(root);
});

test("download inbox recognizes archives and never auto-installs", () => {
  const root = tmpDir("ws-in-");
  const ws = path.join(root, "workshop");
  const downloads = path.join(root, "downloads");
  writeFile(downloads, "PolicingRedefined.zip", "zip");
  writeFile(downloads, "mystery.bin", "nope");
  inbox.startWatch(ws, { workshopId: "local:pr", expected: { expectedCanonicalModId: "policing-redefined" }, sinceMs: 0 });
  const scanned = inbox.scan(ws, downloads);
  const rows = Object.values(scanned.items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "NEW");
  assert.equal(rows[0].name, "PolicingRedefined.zip");
  assert.ok(!Object.values(scanned.items).some((row) => row.state === "INSTALLED"));
  inbox.markRecognized(ws, rows[0].path, { unknown: true });
  assert.equal(inbox.list(ws)[0].state, "UNKNOWN");
  inbox.markRecognized(ws, rows[0].path, { unknown: false, modId: "policing-redefined" });
  assert.equal(inbox.list(ws)[0].state, "RECOGNIZED");
  writeFile(downloads, "EUPMenu_Release_2_3_0_0.zip", "zip");
  writeFile(downloads, "DaVinci_Resolve_20.3.2_Windows.zip", "zip");
  writeFile(downloads, "CHillLSCallouts Texture.oiv", "oiv");
  inbox.scan(ws, downloads);
  const game = inbox.listGameArchives(ws).map((row) => row.name).sort();
  assert.ok(game.includes("PolicingRedefined.zip"));
  assert.ok(game.includes("EUPMenu_Release_2_3_0_0.zip"));
  assert.ok(game.includes("CHillLSCallouts Texture.oiv"));
  assert.equal(game.includes("DaVinci_Resolve_20.3.2_Windows.zip"), false);
  assert.equal(inbox.likelyGameArchive("GrammarPolice-1.8.3.1.zip"), true);
  assert.equal(inbox.likelyGameArchive("RiskierTrafficStops 3.3.3.rar"), true);
  assert.equal(inbox.likelyGameArchive("ypph-perth-intl_QGbOr.zip"), false);
  assert.deepEqual(inbox.listWatchedNew(ws).map((row) => row.name).sort(), [
    "CHillLSCallouts Texture.oiv",
    "EUPMenu_Release_2_3_0_0.zip",
  ]);
  inbox.clearWatch(ws);
  assert.deepEqual(inbox.listWatchedNew(ws), []);
  cleanup(root);
});

test("Get Mod builds a Smart Install handoff and does not install", () => {
  const root = tmpDir("ws-get-");
  const context = ctx(root, { watchDownloads: true, downloadDir: path.join(root, "downloads") });
  fs.mkdirSync(context.downloadDir, { recursive: true });
  const result = workshop.getMod(context, "policing-redefined");
  assert.equal(result.ok, true);
  assert.equal(result.handoff.expectedCanonicalModId, "policing-redefined");
  assert.match(result.sourceUrl, /lcpdfr\.com/);
  cleanup(root);
});

test("local catalog provider search matches aliases and DLL names", () => {
  const loaded = loadCatalog(testCatalog(tmpDir("ws-loc-")));
  const provider = createLocalCatalogProvider(loaded.catalog);
  assert.equal(matchesQuery(loaded.catalog.mods[0], "PR"), true);
  return provider.search("PolicingRedefined.dll").then((rows) => {
    assert.equal(rows[0].id, "policing-redefined");
  });
});
