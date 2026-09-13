const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { writeFile, makeFakeDuty, cleanup } = require("./helpers");
const launchArgs = require("../src/services/launchArgs");
const battleye = require("../src/services/battleye");
const inventoryXml = require("../src/services/knowledge/inventoryXml");
const outfitCheck = require("../src/services/knowledge/outfitCheck");
const dutyWarnings = require("../src/services/knowledge/dutyWarnings");
const runtimeVerify = require("../src/services/knowledge/runtimeVerify");
const dutyHealthV2 = require("../src/services/dutyHealthV2");

const VALID_INVENTORY = `<Inventories>
  <Inventory>
    <Name>Patrol</Name>
    <ScriptName>patrol</ScriptName>
    <Weapon chance="45">WEAPON_PISTOL</Weapon>
    <StunWeapon>WEAPON_STUNGUN</StunWeapon>
  </Inventory>
</Inventories>
`;

const INVALID_INVENTORY = `<Inventories>
  <Inventory>
    <Name>Patrol</Name>
    <ScriptName>patrol</ScriptName>
    <Weapon chance="45">WEAPON_PISTOL</Weapon>
    <StunWeapon chance="">WEAPON_STUNGUN</StunWeapon>
  </Inventory>
</Inventories>
`;

const OUTFITS = `<Outfits>
  <Outfit>
    <Name>The Cop</Name>
    <ScriptName>lspd_cop</ScriptName>
  </Outfit>
</Outfits>
`;

test("duplicate -nobattleye is detected across commandline.txt and args.txt", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "commandline.txt", "-nobattleye\n");
  writeFile(duty, "args.txt", "-nobattleye\n");
  try {
    const dups = launchArgs.findDutyDuplicateFlags(duty);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].flag, "-nobattleye");
    assert.equal(dups[0].count, 2);
    const checks = dutyWarnings.functionTestChecks(duty).checks;
    const row = checks.find((item) => item.id === "launch-args");
    assert.equal(row.ok, false);
    assert.match(row.detail, /Duplicate launch argument detected: -nobattleye/);
  } finally {
    cleanup(duty);
  }
});

test("launch arg dedupe keeps the first flag only", () => {
  const tokens = launchArgs.tokenize("-nobattleye -windowed -nobattleye");
  assert.deepEqual(launchArgs.dedupeLaunchFlags(tokens), ["-nobattleye", "-windowed"]);
});

test("BattlEye off writes -nobattleye once and strips args.txt", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "commandline.txt", "-windowed\n");
  writeFile(duty, "args.txt", "-nobattleye\n");
  try {
    assert.equal(battleye.setFolderFlag(duty, true), true);
    assert.match(fs.readFileSync(path.join(duty, "commandline.txt"), "utf8"), /-nobattleye/);
    assert.equal(fs.existsSync(path.join(duty, "args.txt")), false);
    assert.equal(launchArgs.findDutyDuplicateFlags(duty).length, 0);
    const once = launchArgs.tokenize(fs.readFileSync(path.join(duty, "commandline.txt"), "utf8")).filter(
      (token) => launchArgs.flagKey(token) === "nobattleye"
    );
    assert.equal(once.length, 1);
  } finally {
    cleanup(duty);
  }
});

test("missing outfit detection reports lspd_cop when agency references it", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "lspdfr/data/agency.xml", `<Agency><Ped outfit="lspd_cop" /></Agency>`);
  writeFile(duty, "lspdfr/data/outfits.xml", `<Outfits><Outfit><ScriptName>mp_fib</ScriptName></Outfit></Outfits>`);
  try {
    const info = outfitCheck.inspect(duty);
    assert.ok(info.missingDefs.includes("lspd_cop"));
    const row = dutyWarnings.functionTestChecks(duty).checks.find((item) => item.id === "outfit-defs");
    assert.equal(row.ok, false);
    assert.match(row.detail, /Missing LSPDFR outfit definition: lspd_cop/);
  } finally {
    cleanup(duty);
  }
});

test("valid inventory chance passes validation", () => {
  const parsed = inventoryXml.validateXmlText(VALID_INVENTORY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.chances.length, 0);
});

test("invalid inventory chance is reported with line and key", () => {
  const parsed = inventoryXml.validateXmlText(INVALID_INVENTORY);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.chances[0].key, "chance");
  assert.equal(parsed.chances[0].line, 6);
  assert.match(parsed.chances[0].detail, /blank/i);
});

test("malformed inventory XML is reported", () => {
  const parsed = inventoryXml.validateXmlText("<Inventories><Inventory></Inventories>");
  assert.equal(parsed.ok, false);
  assert.ok(parsed.malformed);
});

test("empty chance is repaired by removing the blank attribute", () => {
  const next = inventoryXml.repairEmptyChance(INVALID_INVENTORY);
  assert.doesNotMatch(next, /chance=""/);
  assert.match(next, /<StunWeapon>WEAPON_STUNGUN<\/StunWeapon>/);
  assert.equal(inventoryXml.validateXmlText(next).ok, true);
});

test("single callout failure stays informational", () => {
  const summary = dutyWarnings.summarize({
    dutyPath: "",
    logText: "CalloutInterface: [WARNING] attempted to start callout Dynamic Traffic Stop but nothing happened\n",
  });
  const row = summary.items.find((item) => /Dynamic Traffic Stop/.test(item.title));
  assert.ok(row);
  assert.equal(row.status, "MONITOR");
  assert.match(row.title, /failed to start 1 time/);
});

test("repeated callout failures escalate", () => {
  const line = "attempted to start callout Dynamic Traffic Stop but nothing happened\n";
  const summary = dutyWarnings.summarize({ dutyPath: "", logText: line.repeat(3) });
  const row = summary.items.find((item) => /Dynamic Traffic Stop/.test(item.title));
  assert.equal(row.status, "WARNING");
  assert.match(row.title, /failed to start 3 times/);
});

test("WeaponSkin go-on-duty crash is reported without blaming a plugin file", () => {
  const log = [
    "Loading plugin from path: C:\\Duty\\Plugins\\LSPD First Response.dll",
    "LSPD First Response: UNHANDLED EXCEPTION DURING GAME FIBER TICK",
    "LSPD First Response: Exception type: System.AccessViolationException",
    "at LSPD_First_Response.Engine.Scripting.Entities.WeaponSkin.FromWeapon(Ped ped, WeaponDescriptor weaponDescriptor)",
    "LSPD First Response: [FATAL] Forced termination",
    "LSPD First Response: [INFO] LSPDFR has shut down",
  ].join("\n");
  assert.equal(dutyWarnings.weaponSkinDutyCrash(log), true);
  const summary = dutyWarnings.summarize({ dutyPath: "", logText: log });
  const row = summary.items.find((item) => item.id === "lspdfr-duty-weaponskin");
  assert.equal(row.status, "WARNING");
  assert.match(row.detail, /not a missing mod file/);
  const checks = dutyWarnings.functionTestChecks("", log).checks;
  const check = checks.find((item) => item.id === "lspdfr-duty-weaponskin");
  assert.equal(check.ok, false);
  assert.equal(check.level, "warn");
});

test("BackupManager exception detection", () => {
  const log = [
    "Started new log on 1",
    "System.NotImplementedException: The method or operation is not implemented.",
    "at LSPD First Response.Mod.BackupManager.cs:line 995",
    "Started new log on 2",
    "System.NotImplementedException: The method or operation is not implemented.",
    "at LSPD First Response.Mod.BackupManager.cs:line 818",
  ].join("\n");
  const hits = dutyWarnings.backupManagerHits(log);
  assert.ok(hits.sessionHits >= 2);
  const summary = dutyWarnings.summarize({ dutyPath: "", logText: log });
  const row = summary.items.find((item) => item.id === "backupmanager");
  assert.equal(row.status, "WARNING");
  assert.match(row.title, /Repeated LSPDFR BackupManager exception/);
});

test("IPT.Common debug message does not fail mod health", () => {
  const ci = {
    id: "ci-1",
    name: "CalloutInterface-1.4.1",
    files: [{ destination: "plugins/LSPDFR/CalloutInterface.dll" }],
  };
  const log = [
    "Creating plugin: CalloutInterface.Main",
    "Creating plugin: IPT.Common.BasePlugin",
    "Error while creating plugin: IPT.Common.BasePlugin: Cannot create an abstract class.",
    "CalloutInterface dependency CalloutInterfaceAPI.dll is available (1.0.3.0).",
  ].join("\n");
  const verdict = runtimeVerify.evaluate(ci, { logText: log });
  assert.equal(verdict.status, "WORKING");
  assert.notEqual(verdict.status, "FAILED");
});

test("D3D debug message does not fail Duty health", () => {
  const summary = dutyHealthV2.summarize({
    tests: { blocking: 0, warnings: 0, checks: [] },
    modHealth: [{ status: "HEALTHY" }],
    profile: { drift: { drifted: false } },
    overlays: {},
  });
  assert.equal(summary.status, "HEALTHY");
  const gfx = dutyWarnings.d3dCrashCorrelated(
    "[d3d12] Hooking game swap chain\nAddress mismatch: 0x1 != 0x2\n[d3d12] Hooked\n"
  );
  assert.equal(gfx.debug, true);
  assert.equal(gfx.crash, false);
  const items = dutyWarnings.summarize({
    dutyPath: "",
    logText: "[d3d12] Hooking game swap chain\nAddress mismatch: 0x1 != 0x2\n[d3d12] Hooked\n",
  }).items;
  const row = items.find((item) => item.id === "d3d-debug");
  assert.equal(row.status, "INFO");
});

test("defined lspd_cop is not reported as a missing definition", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "lspdfr/data/outfits.xml", OUTFITS);
  writeFile(duty, "lspdfr/data/agency.xml", `<Agency><Ped outfit="lspd_cop.m_base" /></Agency>`);
  try {
    const info = outfitCheck.inspect(duty, "GetOutfitVariation: Failed to find outfit lspd_cop");
    assert.equal(info.missingDefs.length, 0);
    assert.deepEqual(info.logMissingDefined, ["lspd_cop"]);
    const row = dutyWarnings.functionTestChecks(duty, "GetOutfitVariation: Failed to find outfit lspd_cop").checks.find(
      (item) => item.id === "outfit-defs"
    );
    assert.equal(row.ok, true);
  } finally {
    cleanup(duty);
  }
});
