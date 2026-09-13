const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { writeFile, fileExists, makeFakeDuty, cleanup } = require("./helpers");
const pluginSupportLayout = require("../src/services/knowledge/pluginSupportLayout");
const dutyLayoutFix = require("../src/services/knowledge/dutyLayoutFix");
const { repairLspdfrLayout } = require("../src/services/installer");
const modCondition = require("../src/services/knowledge/modCondition");

test("stray SlimDX in plugins/LSPDFR is removed when the game root already has it", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "SlimDX.dll", "root-slim");
  writeFile(duty, "plugins/LSPDFR/SlimDX.dll", "plugin-slim");
  writeFile(duty, "plugins/LSPDFR/CalloutInterface.dll", "ci");
  writeFile(duty, "plugins/LSPDFR/XInput1_4.dll", "tiny-hook");
  writeFile(duty, "XInput1_4.dll", "asi-loader");
  try {
    const cleared = pluginSupportLayout.clearStraySupportDlls(duty);
    assert.ok(cleared.removed.includes("plugins/LSPDFR/SlimDX.dll"));
    assert.ok(cleared.removed.includes("plugins/LSPDFR/XInput1_4.dll"));
    assert.equal(fileExists(duty, "plugins/LSPDFR/SlimDX.dll"), false);
    assert.equal(fileExists(duty, "plugins/LSPDFR/CalloutInterface.dll"), true);
    assert.equal(fileExists(duty, "SlimDX.dll"), true);
    assert.equal(require("fs").readFileSync(path.join(duty, "XInput1_4.dll"), "utf8"), "asi-loader");
  } finally {
    cleanup(duty);
  }
});

test("healDutyLayout and launch repair both clear stray support DLLs", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "SlimDX.dll", "root-slim");
  writeFile(duty, "plugins/LSPDFR/SlimDX.dll", "plugin-slim");
  writeFile(duty, "plugins/LSPD First Response.dll", "lspdfr");
  try {
    const healed = dutyLayoutFix.healDutyLayout({ dutyPath: duty });
    assert.ok(healed.removedSupport.includes("plugins/LSPDFR/SlimDX.dll"));
    writeFile(duty, "plugins/LSPDFR/EasyHook.dll", "hook");
    writeFile(duty, "EasyHook.dll", "root-hook");
    repairLspdfrLayout(duty);
    assert.equal(fileExists(duty, "plugins/LSPDFR/EasyHook.dll"), false);
    assert.equal(fileExists(duty, "EasyHook.dll"), true);
  } finally {
    cleanup(duty);
  }
});

test("IPT.Common and RawCanvasUI stay next to the exe and are removed from plugins/LSPDFR", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "IPT.Common.dll", "ipt");
  writeFile(duty, "RawCanvasUI.dll", "ui");
  writeFile(duty, "plugins/LSPDFR/IPT.Common.dll", "ipt-plugin");
  writeFile(duty, "plugins/LSPDFR/RawCanvasUI.dll", "ui-plugin");
  writeFile(duty, "plugins/LSPDFR/CalloutInterface.dll", "ci");
  writeFile(duty, "plugins/LSPDFR/CalloutInterfaceAPI.dll", "api");
  writeFile(
    duty,
    "plugins/LSPD First Response.dll.config",
    `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <runtime>
    <assemblyBinding xmlns="urn:schemas-microsoft-com:asm.v1">
      <probing privatePath="LSPDFR"/>
    </assemblyBinding>
  </runtime>
</configuration>
`
  );
  try {
    const missing = pluginSupportLayout.findMissingPluginLibraries(duty);
    assert.ok(missing.some((row) => /IPT\.Common/i.test(row.name)));
    const mirrored = pluginSupportLayout.mirrorPluginLibraries(duty);
    assert.ok(mirrored.copied.includes("CalloutInterfaceAPI.dll"));
    assert.ok(mirrored.removed.includes("plugins/LSPDFR/IPT.Common.dll"));
    assert.ok(mirrored.removed.includes("plugins/LSPDFR/RawCanvasUI.dll"));
    assert.equal(fileExists(duty, "plugins/LSPDFR/IPT.Common.dll"), false);
    assert.equal(fileExists(duty, "plugins/LSPDFR/RawCanvasUI.dll"), false);
    assert.equal(fileExists(duty, "IPT.Common.dll"), true);
    assert.equal(fileExists(duty, "CalloutInterfaceAPI.dll"), true);
    assert.equal(fileExists(duty, "plugins/LSPDFR/CalloutInterfaceAPI.dll"), true);
    assert.match(
      require("fs").readFileSync(path.join(duty, "plugins", "LSPD First Response.dll.config"), "utf8"),
      /privatePath="LSPDFR;\.\."/
    );
    assert.equal(pluginSupportLayout.findMissingPluginLibraries(duty).length, 0);
    writeFile(duty, "plugins/LSPDFR/IPT.Common.dll", "ipt-again");
    const cleared = pluginSupportLayout.clearStraySupportDlls(duty);
    assert.ok(cleared.removed.includes("plugins/LSPDFR/IPT.Common.dll"));
    assert.equal(fileExists(duty, "plugins/LSPDFR/IPT.Common.dll"), false);
  } finally {
    cleanup(duty);
  }
});

test("a support DLL tracked under plugins/LSPDFR is present if it sits next to the exe", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "SlimDX.dll", "root-slim");
  try {
    assert.equal(pluginSupportLayout.destPresentOnDuty(duty, "plugins/LSPDFR/SlimDX.dll"), true);
    const row = modCondition.evaluateOne(
      {
        id: "setup",
        name: "lspdfr_049_9695_setup.exe",
        enabled: true,
        files: ["plugins/LSPDFR/SlimDX.dll"],
      },
      { source: "FOLDER", dutyPath: duty }
    );
    assert.ok(!row.issues.some((issue) => issue.code === "MISSING_MANAGED_FILE"));
  } finally {
    cleanup(duty);
  }
});
