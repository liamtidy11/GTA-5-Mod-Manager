const { test } = require("node:test");
const assert = require("node:assert/strict");
const { writeFile, cleanup, makeFakeDuty } = require("./helpers");
const mdt = require("../src/services/knowledge/calloutInterfaceMdt");

const ENABLED_INI = `[Controls]
CalloutMenuKey=F8
ToggleTerminalKey=NumPad6
HoldInterval=300

[MDT]
MDTEnabled=True
MDTToggledOn=True
MDTOnlyInVehicle=False
`;

const WORKING_LOG = `
LSPD First Response: CalloutInterface.dll: CalloutInterface, Version=1.4.1.3
LSPD First Response: Creating plugin: CalloutInterface.Main
LSPD First Response: CalloutInterface dependency IPT.Common.dll is available (1.5.0.5).
`;

function diagnose(overrides = {}) {
  return mdt.diagnose({
    configText: ENABLED_INI,
    logText: "",
    peerBinds: [],
    overlayStatus: {},
    verifiedNote: null,
    frameGen: { enabled: false, fsr3FrameGenMode: "0", frameGenType: "0" },
    ...overrides,
  });
}

test("MDT enabled reports ENABLED and the configured NumPad6 key", () => {
  const report = diagnose();
  assert.equal(report.mdt, "ENABLED");
  assert.equal(report.toggleKey, "NUMPAD6");
  assert.equal(report.vehicleOnly, "NO");
  assert.equal(report.config.mdtEnabled, true);
});

test("MDT disabled is a configuration cause, not a plugin failure", () => {
  const report = diagnose({
    configText: ENABLED_INI.replace("MDTEnabled=True", "MDTEnabled=False"),
    logText: WORKING_LOG,
  });
  assert.equal(report.plugin, "WORKING");
  assert.equal(report.mdt, "DISABLED");
  assert.equal(report.cause, "DISABLED");
  assert.match(report.mdtError, /MDTEnabled is False/i);
});

test("NumPad6 is read from ToggleTerminalKey", () => {
  const parsed = mdt.parseConfig(ENABLED_INI);
  assert.equal(mdt.displayKey(parsed.toggleKey), "NUMPAD6");
  assert.equal(parsed.holdInterval, 300);
  assert.equal(parsed.toggleModifier, "None");
});

test("a custom MDT key is reported instead of NumPad6", () => {
  const report = diagnose({
    configText: ENABLED_INI.replace("ToggleTerminalKey=NumPad6", "ToggleTerminalKey=Insert"),
  });
  assert.equal(report.toggleKey, "INSERT");
  assert.match(report.pressHint, /INSERT/);
  assert.doesNotMatch(report.pressHint, /Num Lock/i);
});

test("vehicle-only MDT is reported as YES", () => {
  const report = diagnose({
    configText: ENABLED_INI.replace("MDTOnlyInVehicle=False", "MDTOnlyInVehicle=True"),
    logText: WORKING_LOG,
  });
  assert.equal(report.vehicleOnly, "YES");
  assert.equal(report.cause, "VEHICLE_ONLY");
  assert.match(report.pressHint, /Only while in a vehicle/i);
});

test("a peer plugin using the same MDT key is a conflict", () => {
  const report = diagnose({
    peerBinds: [{ file: "plugins/LSPDFR/Other.ini", name: "OpenMenuKey", value: "NumPad6" }],
  });
  assert.match(report.keyConflict, /Other\.ini/i);
  assert.match(report.keyConflict, /NumPad6/i);
});

test("missing CalloutInterface.ini is reported without inventing a key", () => {
  const report = diagnose({ configText: "" });
  assert.equal(report.config.present, false);
  assert.equal(report.cause, "MISSING_CONFIG");
  assert.equal(report.toggleKey, "UNKNOWN");
  assert.match(report.mdtError, /not found/i);
});

test("malformed MDTEnabled is not treated as enabled", () => {
  const report = diagnose({
    configText: "[MDT]\nMDTEnabled=sometimes\nToggleTerminalKey=NumPad6\n",
  });
  assert.equal(report.config.malformed, true);
  assert.equal(report.config.mdtEnabled, null);
  assert.equal(report.mdt, "UNKNOWN");
  assert.equal(report.cause, "MALFORMED");
});

test("Callout Interface can load while MDT still has no runtime proof", () => {
  const report = diagnose({ logText: WORKING_LOG });
  assert.equal(report.plugin, "WORKING");
  assert.equal(report.mdt, "ENABLED");
  assert.equal(report.cause, "NO_PROOF");
  assert.equal(report.mdtError, "NONE");
  assert.match(report.lastRuntimeEvidence, /Creating plugin: CalloutInterface/i);
});

test("explicit MDT initialization failure is separated from plugin load", () => {
  const report = diagnose({
    logText: `${WORKING_LOG}\nCalloutInterface: MDT failed to initialize\n`,
  });
  assert.equal(report.plugin, "WORKING");
  assert.equal(report.cause, "INIT_FAIL");
  assert.match(report.mdtError, /failed to initialize/i);
});

test("interactive MDT plus D3D12 overlay failure is a render cause", () => {
  const report = diagnose({
    logText: `${WORKING_LOG}
D3D12 command queue does not belong to the D3D12 device, or GetDevice failed. hr: 0x00000000
RawCanvasUI [DEBUG] Canvas setting isInteractive to True
`,
  });
  assert.equal(report.plugin, "WORKING");
  assert.equal(report.cause, "RENDER");
  assert.match(report.mdtError, /D3D12 overlay/i);
  assert.match(report.lastRuntimeEvidence, /isInteractive to True/i);
});

test("Duty-folder diagnose reads the real relative INI path", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "plugins/LSPDFR/CalloutInterface.ini", ENABLED_INI.replace("NumPad6", "F7"));
  writeFile(duty, "plugins/LSPDFR/Other.ini", "OpenMenuKey=F7\n");
  try {
    const report = mdt.diagnose({ dutyPath: duty, logText: WORKING_LOG, overlayStatus: {} });
    assert.equal(report.toggleKey, "F7");
    assert.equal(report.mdt, "ENABLED");
    assert.match(report.keyConflict, /Other\.ini/i);
  } finally {
    cleanup(duty);
  }
});

test("isCalloutInterface matches the disk-discovered DLL shape", () => {
  assert.equal(
    mdt.isCalloutInterface({
      name: "Callout Interface",
      canonicalModId: "callout-interface",
      files: ["plugins\\LSPDFR\\CalloutInterface.dll"],
    }),
    true
  );
  assert.equal(mdt.isCalloutInterface({ name: "Grammar Police", files: ["plugins/LSPDFR/GrammarPolice.dll"] }), false);
});
