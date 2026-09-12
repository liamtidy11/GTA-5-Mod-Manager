const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { tmpDir, makeFakeDuty, cleanup, writeFile } = require("./helpers");
const store = require("../src/services/session/sessionStore");
const { createSessionManager } = require("../src/services/session/sessionManager");
const { createFakeAdapter, parseTasklist } = require("../src/services/session/processMonitor");
const { scanLogText } = require("../src/services/session/logSignals");
const { locateLogs, tailText, readBoundedTail, copyCrashExcerpts, fileMeta } = require("../src/services/session/logCollector");
const { classifyExit } = require("../src/services/session/exitClassifier");
const { captureRecentChanges, captureMods, captureProcesses } = require("../src/services/session/sessionSnapshots");
const { appendAudit } = require("../src/services/smartAudit");
const { SESSION_STATES, SESSION_RESULTS, CONFIDENCE } = require("../src/services/session/sessionTypes");
const { parseWerText } = require("../src/services/session/windowsCrash");

const FIX = path.join(__dirname, "fixtures", "session-logs");

function manager(root, adapter) {
  return createSessionManager({ root, adapter, disableMonitor: true, skipWindows: true });
}

test("session create, persist, atomic update, and timeline", () => {
  const root = tmpDir("sessions-");
  const duty = makeFakeDuty();
  const dataDir = tmpDir("session-data-");
  const sessions = manager(root, createFakeAdapter());
  const created = sessions.beginLaunch({ dutyPath: duty, dataDir, appVersion: "1.0.0" });
  assert.ok(created.sessionId);
  assert.equal(created.state, SESSION_STATES.PREFLIGHT);
  assert.equal(store.getSession(root, created.sessionId).sessionId, created.sessionId);
  store.updateSession(root, created.sessionId, { launch: { via: "test" } });
  assert.equal(store.getSession(root, created.sessionId).launch.via, "test");
  assert.ok(created.timeline.some((row) => row.type === SESSION_STATES.CREATED));
  assert.ok(created.environment);
  assert.ok(Array.isArray(created.mods));
  assert.ok(Array.isArray(created.processes.atLaunch));
  cleanup(root, duty, dataDir);
});

test("environment, mod, recent-change, and process snapshots", () => {
  const duty = makeFakeDuty();
  const dataDir = tmpDir("session-data-");
  appendAudit(dataDir, "INSTALL_COMMITTED", { installId: "install-ub", name: "Ultimate Backup" });
  appendAudit(dataDir, "UPDATED", { installId: "install-ub", name: "Ultimate Backup" });
  const changes = captureRecentChanges(dataDir);
  assert.ok(changes.some((row) => row.event === "UPDATED"));
  assert.deepEqual(captureMods(dataDir, duty), []);
  const adapter = createFakeAdapter([{ image: "Discord.exe", pid: 9, running: true }]);
  const procs = captureProcesses(adapter);
  assert.equal(procs.find((row) => row.image === "Discord.exe").running, true);
  assert.equal(procs.find((row) => row.image === "GTA5_Enhanced.exe").running, false);
  cleanup(duty, dataDir);
});

test("state transitions and process lifecycle", () => {
  const root = tmpDir("sessions-");
  const duty = makeFakeDuty();
  fs.copyFileSync(path.join(FIX, "clean-shutdown.log"), path.join(duty, "RagePluginHook.log"));
  const adapter = createFakeAdapter();
  const sessions = manager(root, adapter);
  const created = sessions.beginLaunch({ dutyPath: duty, dataDir: tmpDir("d-") });
  adapter.setRunning("RagePluginHook.exe", true, { pid: 11 });
  sessions.observe(created);
  assert.ok(["RPH_STARTED", "LSPDFR_LOADING"].includes(sessions.getSession(created.sessionId).state));
  adapter.setRunning("GTA5_Enhanced.exe", true, { pid: 22 });
  sessions.observe(sessions.getSession(created.sessionId));
  assert.equal(sessions.getSession(created.sessionId).state, SESSION_STATES.ACTIVE);
  assert.equal(sessions.getSession(created.sessionId).processes.rph.pid, 11);
  cleanup(root, duty);
});

test("clean exit, launch failed, RPH crash, GTA crash, unknown, and manager termination", () => {
  const clean = classifyExit({
    reachedActive: true,
    rphExited: true,
    gtaExited: true,
    signals: { cleanShutdown: true },
  });
  assert.equal(clean.result, SESSION_RESULTS.CLEAN_EXIT);
  assert.equal(clean.confidence, CONFIDENCE.HIGH);

  const failed = classifyExit({ launchFailed: true, launchFailedMessage: "RPH never started" });
  assert.equal(failed.result, SESSION_RESULTS.LAUNCH_FAILED);

  const rph = classifyExit({
    rphExitedFirst: true,
    gtaStillRunning: true,
    signals: { rphException: true },
  });
  assert.equal(rph.result, SESSION_RESULTS.RPH_CRASH);
  assert.equal(rph.confidence, CONFIDENCE.HIGH);

  const game = classifyExit({
    signals: { gameCrash: true },
    gtaExited: true,
    rphExited: true,
    reachedActive: true,
  });
  assert.equal(game.result, SESSION_RESULTS.GAME_CRASH);

  const unknown = classifyExit({ rphExited: true, gtaExited: true, signals: {} });
  assert.equal(unknown.result, SESSION_RESULTS.UNKNOWN);

  const terminated = classifyExit({ managerTerminated: true });
  assert.equal(terminated.result, SESSION_RESULTS.TERMINATED);
});

test("log fixtures: load, crash, incomplete, malformed, bounded tail, and hash", () => {
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "clean-shutdown.log"), "utf8")).lspdfrLoaded, true);
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "rph-crash.log"), "utf8")).rphException, true);
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "lspdfr-exception.log"), "utf8")).lspdfrFailed, true);
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "game-crash.log"), "utf8")).gameCrash, true);
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "incomplete.log"), "utf8")).lspdfrLoaded, false);
  assert.equal(scanLogText(fs.readFileSync(path.join(FIX, "malformed.log"), "utf8")).cleanShutdown, false);

  const duty = makeFakeDuty();
  fs.copyFileSync(path.join(FIX, "clean-shutdown.log"), path.join(duty, "RagePluginHook.log"));
  const located = locateLogs(duty);
  assert.equal(located[0].name, "RagePluginHook.log");
  assert.ok(located[0].hash);
  const long = Array.from({ length: 600 }, (_, i) => `line-${i}`).join("\n");
  assert.equal(tailText(long, 400).split(/\n/).length, 400);
  const dest = tmpDir("copied-logs-");
  const copied = copyCrashExcerpts(dest, located);
  assert.equal(copied[0].hash.length, 64);
  assert.ok(copied[0].lines <= 400);
  assert.ok(readBoundedTail(located[0].path).includes("Normal shutdown"));
  cleanup(duty, dest);
});

test("finalize crash copies log tails and manager launch-failed", () => {
  const root = tmpDir("sessions-");
  const duty = makeFakeDuty();
  fs.copyFileSync(path.join(FIX, "rph-crash.log"), path.join(duty, "RagePluginHook.log"));
  const adapter = createFakeAdapter([
    { image: "RagePluginHook.exe", pid: 1, running: true },
    { image: "GTA5_Enhanced.exe", pid: 2, running: true },
  ]);
  const sessions = manager(root, adapter);
  const created = sessions.beginLaunch({ dutyPath: duty, dataDir: tmpDir("d-") });
  sessions.observe(created);
  adapter.setRunning("RagePluginHook.exe", false);
  const afterRph = sessions.observe(sessions.getSession(created.sessionId));
  adapter.setRunning("GTA5_Enhanced.exe", false);
  const done = sessions.observe(afterRph);
  assert.equal(done.result, SESSION_RESULTS.RPH_CRASH);
  assert.ok(done.copiedLogs && done.copiedLogs.length);
  assert.ok(done.evidence.length);

  const failedDuty = makeFakeDuty();
  const fail = manager(root, createFakeAdapter());
  fail.beginLaunch({ dutyPath: failedDuty, dataDir: tmpDir("d2-") });
  const launched = fail.failLaunch(new Error("Windows asked for permission and it was declined."));
  assert.equal(launched.result, SESSION_RESULTS.LAUNCH_FAILED);
  cleanup(root, duty, failedDuty);
});

test("incomplete recovery does not mark a crash just because the manager restarted", () => {
  const root = tmpDir("sessions-");
  const duty = makeFakeDuty();
  fs.copyFileSync(path.join(FIX, "incomplete.log"), path.join(duty, "RagePluginHook.log"));
  const adapter = createFakeAdapter();
  const sessions = manager(root, adapter);
  const created = sessions.beginLaunch({ dutyPath: duty, dataDir: tmpDir("d-") });
  assert.equal(created.incomplete, true);
  const recovered = sessions.reconcileIncomplete();
  assert.ok(recovered.includes(created.sessionId));
  const next = sessions.getSession(created.sessionId);
  assert.notEqual(next.result, SESSION_RESULTS.GAME_CRASH);
  assert.notEqual(next.result, SESSION_RESULTS.RPH_CRASH);
  cleanup(root, duty);
});

test("history queries, latest session, sessions by mod, and retention", () => {
  const root = tmpDir("sessions-");
  const duty = makeFakeDuty();
  const dataDir = tmpDir("d-");
  const sessions = manager(root, createFakeAdapter());
  const a = sessions.beginLaunch({ dutyPath: duty, dataDir });
  store.finalizeSession(root, a.sessionId, {
    state: SESSION_STATES.COMPLETED,
    result: SESSION_RESULTS.CLEAN_EXIT,
    incomplete: false,
    mods: [{ installId: "mod-a", enabled: true }],
  });
  const b = sessions.beginLaunch({ dutyPath: duty, dataDir });
  store.finalizeSession(root, b.sessionId, {
    state: SESSION_STATES.CRASHED,
    result: SESSION_RESULTS.RPH_CRASH,
    incomplete: false,
    mods: [{ installId: "mod-a", enabled: true }],
  });
  assert.ok(sessions.getLatestSession());
  assert.equal(sessions.getSuccessfulSessions(5).length, 1);
  assert.equal(sessions.getFailedSessions(5).length, 1);
  assert.ok(sessions.getSessionsForMod("mod-a").length >= 1);
  store.prune(root, 1);
  assert.equal(store.listSessions(root).length, 1);
  cleanup(root, duty, dataDir);
});

test("tasklist parser and Windows crash parser stay conservative", () => {
  const rows = parseTasklist("RagePluginHook.exe               4321 Console", "RagePluginHook.exe");
  assert.equal(rows[0].pid, 4321);
  assert.deepEqual(parseWerText("nothing relevant"), []);
  const parsed = parseWerText("Faulting application name: GTA5_Enhanced.exe, version: 1.0\nFaulting module name: foo.dll\nException code: 0xc0000005");
  assert.equal(parsed[0].faultingApplication, "GTA5_Enhanced.exe");
  assert.ok(fileMeta);
});
