const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { tmpDir, writeFile, readFile, fileExists, makeFakeDuty, cleanup } = require("./helpers");
const smartInstall = require("../src/services/smartInstall");

function ctx() {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("data-");
  const staging = tmpDir("staging-");
  return { duty, dataDir, staging };
}

test("installs a plugin pack and writes a manifest", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "COOL-PLUGIN");
  writeFile(payload, "Menyoo.asi", "ASI-BODY");
  writeFile(payload, "readme.txt", "junk");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    assert.notEqual(preview.conflicts.severity, "BLOCKED");
    assert.equal(preview.counts.add, 2);

    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    assert.equal(manifest.files.length, 2);
    assert.ok(manifest.files.every((f) => f.hash && f.hash.length === 64));
    assert.equal(fileExists(duty, "plugins/LSPDFR/Cool.dll"), true);
    assert.equal(fileExists(duty, "Menyoo.asi"), true);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "COOL-PLUGIN");

    const list = smartInstall.list(dataDir);
    assert.equal(list.length, 1);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("overwriting an existing file backs it up and uninstall restores it", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(duty, "plugins/LSPDFR/Cool.dll", "ORIGINAL");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "NEW-VERSION");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const target = preview.files.find((f) => f.destination.endsWith("Cool.dll"));
    assert.equal(target.action, "replace");

    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "NEW-VERSION");
    assert.ok(manifest.files[0].backup, "a backup should be recorded");

    const result = await smartInstall.uninstall({ modId: manifest.id, dutyPath: duty, dataDir });
    assert.equal(result.restored, 1);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "ORIGINAL");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("a failed copy rolls back every change", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/A.dll", "A");
  writeFile(payload, "plugins/LSPDFR/B.dll", "B");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });

    await assert.rejects(
      () => smartInstall.commit({ preview, dutyPath: duty, dataDir, hooks: { failAtCopy: 1 } }),
      /rolled back/i
    );

    // Neither file should remain, and no manifest should be written.
    assert.equal(fileExists(duty, "plugins/LSPDFR/A.dll"), false);
    assert.equal(fileExists(duty, "plugins/LSPDFR/B.dll"), false);
    assert.equal(smartInstall.list(dataDir).length, 0);
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("a protected ASI loader is skipped, not overwritten", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  const bigLoader = Buffer.alloc(2_000_000, 1);
  fs.writeFileSync(path.join(duty, "XInput1_4.dll"), bigLoader);
  writeFile(payload, "XInput1_4.dll", "tiny-hook");
  writeFile(payload, "plugins/LSPDFR/Ok.dll", "OK");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const loader = preview.files.find((f) => f.destination.toLowerCase() === "xinput1_4.dll");
    assert.equal(loader.action, "skip");
    assert.equal(preview.conflicts.severity, "HIGH_RISK");

    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });
    // The big loader must be untouched; only Ok.dll installed.
    assert.equal(fs.statSync(path.join(duty, "XInput1_4.dll")).size, 2_000_000);
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].destination, "plugins/LSPDFR/Ok.dll");
    assert.ok(manifest.skipped.some((s) => s.destination.toLowerCase() === "xinput1_4.dll"));
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});

test("shared files are kept until the last owner is removed", async () => {
  const { duty, dataDir, staging } = ctx();
  const payloadA = tmpDir("payloadA-");
  const payloadB = tmpDir("payloadB-");
  writeFile(payloadA, "plugins/LSPDFR/Shared.dll", "A");
  writeFile(payloadB, "plugins/LSPDFR/Shared.dll", "B");
  try {
    const previewA = await smartInstall.analyze({ source: payloadA, dutyPath: duty, dataDir, stagingRoot: staging });
    const modA = await smartInstall.commit({ preview: previewA, dutyPath: duty, dataDir });

    const previewB = await smartInstall.analyze({ source: payloadB, dutyPath: duty, dataDir, stagingRoot: staging });
    const modB = await smartInstall.commit({ preview: previewB, dutyPath: duty, dataDir });

    // Removing B leaves the shared file because A still owns it.
    const rB = await smartInstall.uninstall({ modId: modB.id, dutyPath: duty, dataDir });
    assert.equal(rB.kept, 1);
    assert.equal(fileExists(duty, "plugins/LSPDFR/Shared.dll"), true);

    // Removing A (last owner) removes the file.
    await smartInstall.uninstall({ modId: modA.id, dutyPath: duty, dataDir });
    assert.equal(fileExists(duty, "plugins/LSPDFR/Shared.dll"), false);
  } finally {
    cleanup(duty, dataDir, staging, payloadA, payloadB);
  }
});

test("disable parks files and enable restores them", async () => {
  const { duty, dataDir, staging } = ctx();
  const payload = tmpDir("payload-");
  writeFile(payload, "plugins/LSPDFR/Cool.dll", "COOL");
  try {
    const preview = await smartInstall.analyze({ source: payload, dutyPath: duty, dataDir, stagingRoot: staging });
    const manifest = await smartInstall.commit({ preview, dutyPath: duty, dataDir });

    await smartInstall.setEnabled({ modId: manifest.id, dutyPath: duty, dataDir, enabled: false });
    assert.equal(fileExists(duty, "plugins/LSPDFR/Cool.dll"), false);

    await smartInstall.setEnabled({ modId: manifest.id, dutyPath: duty, dataDir, enabled: true });
    assert.equal(fileExists(duty, "plugins/LSPDFR/Cool.dll"), true);
    assert.equal(readFile(duty, "plugins/LSPDFR/Cool.dll"), "COOL");
  } finally {
    cleanup(duty, dataDir, staging, payload);
  }
});
