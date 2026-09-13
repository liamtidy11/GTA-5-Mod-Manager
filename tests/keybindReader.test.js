const { test } = require("node:test");
const assert = require("node:assert");
const { tmpDir, writeFile, cleanup } = require("./helpers");
const keybindReader = require("../src/services/knowledge/keybindReader");

test("INI keybinds are read and pretty-printed", () => {
  const rows = keybindReader.parseIni(
    `[InteractionSettings]\nOpenMenuKey=T\nOpenMiscMenu=LControlKey + T\nUnused=None\n`,
    "InteractionSettings.ini"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].keys, "T");
  assert.equal(rows[1].keys, "Left Ctrl + T");
  assert.match(rows[0].action, /open menu/i);
});

test("README lines that name a key and what it does are captured", () => {
  const rows = keybindReader.parseReadme("Press B to open the backup menu.\nHold Left Shift + G to deploy spikes.");
  assert.ok(rows.some((row) => /backup/i.test(row.action) && row.keys === "B"));
});

test("installed config wins over typical Policing Redefined defaults", () => {
  const duty = tmpDir("duty-keys-");
  writeFile(duty, "plugins/LSPDFR/PolicingRedefined/InteractionSettings.ini", "OpenMenuKey=F8\n");
  try {
    const info = keybindReader.readKeybinds({
      canonicalModId: "policing-redefined",
      dutyPath: duty,
      manifest: { files: [{ destination: "plugins/LSPDFR/PolicingRedefined/InteractionSettings.ini" }] },
    });
    assert.equal(info.fromConfig, true);
    assert.ok(info.binds.some((row) => row.keys === "F8"));
    assert.equal(info.binds.some((row) => row.source === "typical"), false);
  } finally {
    cleanup(duty);
  }
});

test("Callout Interface MDT key is read from the installed INI, not the catalog default", () => {
  const duty = tmpDir("duty-ci-keys-");
  writeFile(
    duty,
    "plugins/LSPDFR/CalloutInterface.ini",
    "[Controls]\nToggleTerminalKey=Insert\nCalloutMenuKey=F8\n"
  );
  try {
    const info = keybindReader.readKeybinds({
      canonicalModId: "callout-interface",
      dutyPath: duty,
      mod: { files: [{ destination: "plugins/LSPDFR/CalloutInterface.dll" }] },
    });
    assert.equal(info.fromConfig, true);
    const mdt = info.binds.find((row) => /toggle terminal/i.test(row.action));
    assert.ok(mdt);
    assert.equal(mdt.keys, "Insert");
    assert.equal(info.binds.some((row) => row.source === "typical"), false);
  } finally {
    cleanup(duty);
  }
});

test("NumPad keys are pretty-printed", () => {
  assert.equal(keybindReader.prettyKeys("NumPad6"), "NumPad 6");
});

test("Policing Redefined details fall back to typical defaults when settings are empty", () => {
  const info = keybindReader.readKeybinds({ canonicalModId: "policing-redefined", dutyPath: "", manifest: { files: [] } });
  assert.equal(info.typicalUsed, true);
  assert.ok(info.binds.some((row) => row.keys === "T" && /interaction|stop/i.test(row.action)));
  assert.ok(info.binds.some((row) => /left ctrl \+ b/i.test(row.keys)));
});
