const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { writeFile, cleanup, makeFakeDuty } = require("./helpers");
const stack = require("../src/services/knowledge/mdtRenderStack");
const mdt = require("../src/services/knowledge/calloutInterfaceMdt");

const WORKING = `
LSPD First Response: Creating plugin: CalloutInterface.Main
LSPD First Response: RawCanvasUI [DEBUG] canvas updated bounds: resolution {Width=5120, Height=1440}
`;

function version(fileVersion) {
  return () => ({ fileVersion, productVersion: fileVersion });
}

test("correct RawCanvasUI version detection", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "RawCanvasUI.dll", "raw-043");
  try {
    const inv = stack.inventoryUiLibraries(duty, { readVersion: version("0.4.3.0") });
    assert.equal(inv.rawCanvas.version, "0.4.3.0");
    assert.equal(inv.rawCanvas.mismatch, false);
    assert.equal(inv.rawCanvas.loadedRel, "RawCanvasUI.dll");
    assert.equal(inv.rawCanvas.expectedVersion, "0.4.3.0");
  } finally {
    cleanup(duty);
  }
});

test("duplicate RawCanvasUI detection", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "RawCanvasUI.dll", "root-copy");
  writeFile(duty, "plugins/LSPDFR/RawCanvasUI.dll", "plugin-copy");
  try {
    const inv = stack.inventoryUiLibraries(duty, { readVersion: version("0.4.3.0") });
    assert.equal(inv.rawCanvas.duplicate, true);
    assert.equal(inv.rawCanvas.identicalDuplicates, false);
    assert.equal(inv.rawCanvas.copies.length, 2);
  } finally {
    cleanup(duty);
  }
});

test("wrong RawCanvasUI version", () => {
  const duty = makeFakeDuty();
  writeFile(duty, "RawCanvasUI.dll", "raw-051");
  try {
    const inv = stack.inventoryUiLibraries(duty, { readVersion: version("0.5.1.0") });
    assert.equal(inv.rawCanvas.mismatch, true);
    const fix = stack.suggestedFix({
      render: { renderFailed: true, renderConfirmed: false },
      inventory: inv,
    });
    assert.match(fix, /0\.4\.3\.0/);
  } finally {
    cleanup(duty);
  }
});

test("overlay conflict is reported without closing anything", () => {
  const snap = stack.overlaySnapshot({ nvidiaOverlay: true, discord: true });
  assert.equal(snap.anyRunning, true);
  assert.deepEqual(snap.names, ["NVIDIA Overlay", "Discord"]);
  const fix = stack.suggestedFix({
    render: { renderFailed: true, renderConfirmed: false },
    overlays: snap,
  });
  assert.match(fix, /NVIDIA Overlay/i);
});

test("input detected but no render stays UNVERIFIED, not CONFIRMED", () => {
  const render = stack.classifyRender(`${WORKING}
RawCanvasUI [DEBUG] Canvas setting isInteractive to True
`);
  assert.equal(render.input, "DETECTED");
  assert.equal(render.canvas, "INITIALIZED");
  assert.equal(render.rendering, "UNVERIFIED");
  assert.equal(render.status, stack.RENDER.INPUT_DETECTED);
  assert.equal(render.renderConfirmed, false);
});

test("explicit D3D12 render failure", () => {
  const render = stack.classifyRender(`${WORKING}
D3D12 command queue does not belong to the D3D12 device, or GetDevice failed. hr: 0x00000000
RawCanvasUI [DEBUG] Canvas setting isInteractive to True
`);
  assert.equal(render.rendering, "FAILED");
  assert.equal(render.status, stack.RENDER.RENDER_FAILED);
  assert.match(render.lastError, /D3D12 command queue/);
  const report = mdt.diagnose({
    configText: "[MDT]\nMDTEnabled=True\nToggleTerminalKey=NumPad6\n",
    logText: `Creating plugin: CalloutInterface.Main\n${render.lastError}\nRawCanvasUI [DEBUG] Canvas setting isInteractive to True`,
    overlayStatus: {},
    peerBinds: [],
    verifiedNote: null,
    frameGen: { enabled: true, fsr3FrameGenMode: "1", frameGenType: "1" },
  });
  assert.equal(report.mdtRendering, "FAILED");
  assert.equal(report.plugin, "WORKING");
});

test("user-verified MDT with frame generation off is WORKING even if the init queue line is present", () => {
  const report = mdt.diagnose({
    configText: "[MDT]\nMDTEnabled=True\nToggleTerminalKey=NumPad6\n",
    logText: `Creating plugin: CalloutInterface.Main
D3D12 command queue does not belong to the D3D12 device, or GetDevice failed. hr: 0x00000000
RawCanvasUI [DEBUG] canvas updated bounds: resolution {Width=5120, Height=1440}
RawCanvasUI [DEBUG] Canvas setting isInteractive to True
`,
    overlayStatus: {},
    peerBinds: [],
    verifiedNote: { verified: true, frameGenOff: true, source: "user" },
    frameGen: { enabled: false, fsr3FrameGenMode: "0", frameGenType: "0" },
  });
  assert.equal(report.plugin, "WORKING");
  assert.equal(report.mdtRendering, "WORKING");
  assert.equal(report.renderStatus, stack.RENDER.RENDER_CONFIRMED);
  assert.equal(report.lastRenderError, "NONE");
  assert.match(report.suggestedFix, /Keep FSR3 frame generation off/);
});

test("successful render evidence is required for WORKING", () => {
  const render = stack.classifyRender(`${WORKING}
RawCanvasUI [DEBUG] Canvas setting isInteractive to True
RawCanvasUI [DEBUG] frame presented
`);
  assert.equal(render.rendering, "WORKING");
  assert.equal(render.status, stack.RENDER.RENDER_CONFIRMED);
});

test("rollback after dependency test restores the original bytes", () => {
  const duty = makeFakeDuty();
  const file = path.join(duty, "RawCanvasUI.dll");
  writeFile(duty, "RawCanvasUI.dll", "ORIGINAL");
  const seen = stack.withTemporaryFile(file, "EXPERIMENT", () => {
    assert.equal(fs.readFileSync(file, "utf8"), "EXPERIMENT");
    return "ran";
  });
  assert.equal(seen, "ran");
  assert.equal(fs.readFileSync(file, "utf8"), "ORIGINAL");
  cleanup(duty);
});

test("failed experimental test leaves Duty unchanged", () => {
  const duty = makeFakeDuty();
  const file = path.join(duty, "RawCanvasUI.dll");
  writeFile(duty, "RawCanvasUI.dll", "SAFE");
  assert.throws(() => {
    stack.withTemporaryFile(file, "BROKEN", () => {
      throw new Error("incompatible");
    });
  }, /incompatible/);
  assert.equal(fs.readFileSync(file, "utf8"), "SAFE");
  cleanup(duty);
});
