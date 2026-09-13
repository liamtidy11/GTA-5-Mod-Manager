const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, cleanup } = require("./helpers");
const gfx = require("../src/services/knowledge/gtaEnhancedGraphics");

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<Settings>
  <graphics>
    <FrameGenType value="1" />
    <fsr3FrameGenMode value="1" />
    <fsr3Quality value="2" />
  </graphics>
</Settings>
`;

test("disableFrameGen only clears the frame-generation keys", () => {
  const next = gfx.disableFrameGen(SAMPLE);
  assert.equal(next.changed, true);
  const state = gfx.frameGenState(next.text);
  assert.equal(state.enabled, false);
  assert.equal(state.fsr3FrameGenMode, "0");
  assert.equal(state.frameGenType, "0");
  assert.match(next.text, /fsr3Quality value="2"/);
});

test("backup and restore leave the original settings bytes", () => {
  const dir = tmpDir("gta-gfx-");
  const file = path.join(dir, "settings.xml");
  fs.writeFileSync(file, SAMPLE);
  try {
    const applied = gfx.backupAndDisableFrameGen(file);
    assert.equal(applied.ok, true);
    assert.equal(applied.before.enabled, true);
    assert.equal(applied.after.enabled, false);
    assert.equal(fs.existsSync(applied.backup), true);
    assert.match(fs.readFileSync(file, "utf8"), /fsr3FrameGenMode value="0"/);
    const restored = gfx.restoreFrameGenBackup(file);
    assert.equal(restored.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), SAMPLE);
  } finally {
    cleanup(dir);
  }
});

test("a failed experimental edit can be rolled back from the backup", () => {
  const dir = tmpDir("gta-gfx-fail-");
  const file = path.join(dir, "settings.xml");
  fs.writeFileSync(file, SAMPLE);
  try {
    gfx.backupAndDisableFrameGen(file);
    fs.writeFileSync(file, SAMPLE.replace('value="1"', 'value="9"'));
    const restored = gfx.restoreFrameGenBackup(file);
    assert.equal(restored.ok, true);
    assert.equal(fs.readFileSync(file, "utf8"), SAMPLE);
  } finally {
    cleanup(dir);
  }
});
