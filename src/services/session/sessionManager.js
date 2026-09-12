const crypto = require("crypto");
const path = require("path");
const overlays = require("../overlays");
const store = require("./sessionStore");
const {
  SESSION_STATES,
  SESSION_RESULTS,
  CONFIDENCE,
  EVENT_ACTORS,
  TERMINAL_STATES,
  CRASH_RESULTS,
  POLL_MS,
} = require("./sessionTypes");
const { systemAdapter, snapshotKnown, findRunning, RPH_IMAGES, GTA_IMAGES, KNOWN_IMAGES } = require("./processMonitor");
const { captureEnvironment, captureMods, captureRecentChanges, captureProcesses } = require("./sessionSnapshots");
const { collectForSession, copyCrashExcerpts } = require("./logCollector");
const { classifyExit } = require("./exitClassifier");
const { collectWindowsCrash } = require("./windowsCrash");
const { scanLogText } = require("./logSignals");
const { readBoundedTail } = require("./logCollector");

function newId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `session-${Date.now().toString(36)}`;
}

function createSessionManager(options = {}) {
  const root = options.root;
  if (!root) throw new Error("Session root is required.");
  const adapter = options.adapter || systemAdapter();
  const pollMs = options.pollMs == null ? POLL_MS : options.pollMs;
  const nowFn = options.now || (() => new Date().toISOString());
  let timer = null;
  let currentId = null;

  function nowIso() {
    return nowFn();
  }

  function load(sessionId = currentId) {
    return sessionId ? store.getSession(root, sessionId) : null;
  }

  function persist(session, patch = {}) {
    const next = store.updateSession(root, session.sessionId, { ...session, ...patch });
    return next || session;
  }

  function addEvent(session, type, details = {}, actor = EVENT_ACTORS.PROCESS_EVENT) {
    session.timeline = [...(session.timeline || []), { time: nowIso(), type, actor, details }];
    return persist(session, { timeline: session.timeline, state: session.state });
  }

  function setState(session, state, details, actor = EVENT_ACTORS.PROCESS_EVENT) {
    if (session.state === state) return session;
    session.state = state;
    return addEvent(session, state, details || {}, actor);
  }

  function beginLaunch({
    dutyPath,
    officialPath = "",
    dataDir = "",
    appVersion = "1.0.0",
    overlayStatus = null,
    retestOfSessionId = "",
    crashActionId = "",
    profileId = "",
    snapshotId = "",
  } = {}) {
    const existing = load();
    if (existing && !TERMINAL_STATES.has(existing.state)) {
      finalize(existing.sessionId, { managerTerminated: true });
    }

    const sessionId = newId();
    const overlay = overlayStatus || overlays.overlayStatus();
    const session = store.createSession(root, {
      sessionId,
      startedAt: nowIso(),
      endedAt: null,
      state: SESSION_STATES.CREATED,
      incomplete: true,
      result: null,
      confidence: CONFIDENCE.UNKNOWN,
      evidence: [],
      timeline: [{ time: nowIso(), type: SESSION_STATES.CREATED, actor: EVENT_ACTORS.USER_ACTION, details: {} }],
      appVersion,
      dutyPath,
      officialPath: officialPath ? "set" : "",
      launch: { via: "", arguments: [] },
      environment: captureEnvironment(dutyPath, dataDir),
      mods: captureMods(dataDir, dutyPath),
      recentChanges: captureRecentChanges(dataDir),
      processes: { atLaunch: captureProcesses(adapter), rph: null, gta: null },
      overlays: {
        atLaunch: overlay,
        nvidiaDetected: Boolean(overlay.nvidiaOverlay || overlay.nvidiaShare),
        nvidiaClosedByManager: false,
      },
      logs: collectForSession(dutyPath).logs,
      durationMs: null,
      activeConfidence: CONFIDENCE.UNKNOWN,
      retestOfSessionId: retestOfSessionId || null,
      crashActionId: crashActionId || null,
      profileId: profileId || null,
      snapshotId: snapshotId || null,
    });
    currentId = sessionId;
    setState(session, SESSION_STATES.PREFLIGHT, { dutyPath }, EVENT_ACTORS.MANAGER_ACTION);
    return store.getSession(root, sessionId);
  }

  function markLaunching(launchResult = {}, extras = {}) {
    const session = load();
    if (!session) return null;
    if (extras.nvidiaClosedByManager) {
      session.overlays = { ...session.overlays, nvidiaClosedByManager: true };
      addEvent(session, "OVERLAY_CLOSED", { name: "NVIDIA Overlay" }, EVENT_ACTORS.MANAGER_ACTION);
    } else if (session.overlays && session.overlays.nvidiaDetected) {
      addEvent(session, "OVERLAY_DETECTED", { name: "NVIDIA Overlay" }, EVENT_ACTORS.PROCESS_EVENT);
    }
    session.launch = { via: launchResult.via || "", arguments: [] };
    setState(session, SESSION_STATES.LAUNCHING, { via: launchResult.via || "" }, EVENT_ACTORS.MANAGER_ACTION);
    return store.getSession(root, session.sessionId);
  }

  function failLaunch(error) {
    const session = load();
    if (!session) return null;
    return finalize(session.sessionId, {
      launchFailed: true,
      launchFailedMessage: error && error.message ? error.message : String(error || "Launch failed."),
    });
  }

  function observe(session) {
    const snap = snapshotKnown(adapter, KNOWN_IMAGES);
    const rph = findRunning(snap, RPH_IMAGES);
    const gta = findRunning(snap, GTA_IMAGES);
    const logs = collectForSession(session.dutyPath);
    const logText = (logs.logs.find((row) => /ragepluginhook\.log$/i.test(row.name)) || {}).path;
    const signals = logText ? scanLogText(readBoundedTail(logText)) : logs.signals || {};

    if (rph && !session.processes.rph) {
      session.processes.rph = { pid: rph.pid, startedAt: nowIso(), image: rph.image };
      setState(session, SESSION_STATES.RPH_STARTED, { pid: rph.pid });
    }
    if (gta && !session.processes.gta) {
      session.processes.gta = { pid: gta.pid, startedAt: nowIso(), image: gta.image };
      setState(session, SESSION_STATES.GAME_STARTED, { pid: gta.pid });
    }

    if (signals.lspdfrLoading && session.state !== SESSION_STATES.ACTIVE) {
      setState(session, SESSION_STATES.LSPDFR_LOADING, {}, EVENT_ACTORS.LOG_EVENT);
    }
    if ((signals.lspdfrLoaded || signals.lspdfrLoading) && rph && gta) {
      session.activeConfidence = CONFIDENCE.HIGH;
      setState(session, SESSION_STATES.ACTIVE, { confidence: CONFIDENCE.HIGH }, EVENT_ACTORS.LOG_EVENT);
    } else if (rph && gta && session.processes.rph && session.processes.gta && session.state !== SESSION_STATES.ACTIVE) {
      session.activeConfidence = CONFIDENCE.LOW;
      setState(session, SESSION_STATES.ACTIVE, { confidence: CONFIDENCE.LOW });
    }

    const rphGone = session.processes.rph && !rph;
    const gtaGone = session.processes.gta && !gta;
    if (rphGone && !session.processes.rph.exitedAt) {
      session.processes.rph = { ...session.processes.rph, exitedAt: nowIso() };
      addEvent(session, "RPH_EXITED", { pid: session.processes.rph.pid });
    }
    if (gtaGone && !session.processes.gta.exitedAt) {
      session.processes.gta = { ...session.processes.gta, exitedAt: nowIso() };
      addEvent(session, "GTA_EXITED", { pid: session.processes.gta.pid });
    }

    persist(session, {
      processes: session.processes,
      logs: logs.logs,
      activeConfidence: session.activeConfidence,
    });

    if ((rphGone && gtaGone) || (session.processes.rph && rphGone && !session.processes.gta && Date.parse(nowIso()) - Date.parse(session.startedAt) > 20000)) {
      return finalize(session.sessionId, { signals });
    }
    if (!session.processes.rph && !session.processes.gta && Date.parse(nowIso()) - Date.parse(session.startedAt) > 20000) {
      return finalize(session.sessionId, { launchFailed: true, launchFailedMessage: "RPH and GTA were never detected." });
    }
    return store.getSession(root, session.sessionId);
  }

  function startMonitor() {
    stopMonitor();
    if (options.disableMonitor) return;
    timer = setInterval(() => {
      try {
        const session = load();
        if (!session || TERMINAL_STATES.has(session.state)) {
          stopMonitor();
          return;
        }
        observe(session);
      } catch {
        /* observation must never break launch */
      }
    }, pollMs);
    if (timer.unref) timer.unref();
  }

  function stopMonitor() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function finalize(sessionId, extras = {}) {
    stopMonitor();
    const session = store.getSession(root, sessionId);
    if (!session || (TERMINAL_STATES.has(session.state) && session.result && extras.force !== true)) {
      return session;
    }
    const logs = collectForSession(session.dutyPath);
    const primary = logs.logs.find((row) => /ragepluginhook\.log$/i.test(row.name));
    const signals = extras.signals || (primary ? scanLogText(readBoundedTail(primary.path)) : logs.signals || {});
    let windows = [];
    try {
      windows = collectWindowsCrash({ skip: extras.skipWindows === true, adapter: extras.windowsAdapter });
    } catch {
      windows = [];
    }
    const rphExited = Boolean(session.processes.rph && session.processes.rph.exitedAt);
    const gtaExited = Boolean(session.processes.gta && session.processes.gta.exitedAt);
    const rphExitedFirst =
      rphExited && session.processes.gta && session.processes.rph.exitedAt && (!session.processes.gta.exitedAt || session.processes.rph.exitedAt <= session.processes.gta.exitedAt);
    const gtaExitedFirst =
      gtaExited && session.processes.rph && session.processes.gta.exitedAt && (!session.processes.rph.exitedAt || session.processes.gta.exitedAt < session.processes.rph.exitedAt);

    const classified = classifyExit({
      managerTerminated: extras.managerTerminated === true,
      launchFailed: extras.launchFailed === true,
      launchFailedMessage: extras.launchFailedMessage,
      rphSeen: Boolean(session.processes.rph),
      gtaSeen: Boolean(session.processes.gta),
      rphExited,
      gtaExited,
      rphExitedFirst,
      gtaExitedFirst,
      gtaStillRunning: Boolean(session.processes.gta && !session.processes.gta.exitedAt),
      reachedActive: session.state === SESSION_STATES.ACTIVE || Boolean(session.activeConfidence && session.activeConfidence !== CONFIDENCE.UNKNOWN),
      signals,
      windowsFaultingApp: windows[0] && windows[0].faultingApplication,
    });

    const unexpected = CRASH_RESULTS.has(classified.result);
    let copied = [];
    if (unexpected || classified.result === SESSION_RESULTS.LAUNCH_FAILED) {
      copied = copyCrashExcerpts(path.join(store.sessionDir(root, session.sessionId), "logs"), logs.logs);
    }

    const endedAt = nowIso();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(session.startedAt));
    const state = unexpected
      ? SESSION_STATES.CRASHED
      : classified.result === SESSION_RESULTS.UNKNOWN
        ? SESSION_STATES.UNKNOWN
        : SESSION_STATES.COMPLETED;

    addEvent(session, state, { result: classified.result }, EVENT_ACTORS.PROCESS_EVENT);
    const finalized = store.finalizeSession(root, session.sessionId, {
      state,
      result: classified.result,
      confidence: classified.confidence,
      evidence: classified.evidence,
      endedAt,
      durationMs,
      incomplete: false,
      logs: logs.logs,
      copiedLogs: copied,
      windowsCrash: windows,
      retestOfSessionId: session.retestOfSessionId || null,
      crashActionId: session.crashActionId || null,
    });
    if (typeof options.onSessionFinalized === "function") {
      try {
        options.onSessionFinalized(finalized);
      } catch {
        /* crash-action bookkeeping must not break session finalize */
      }
    }
    return finalized;
  }

  function reconcileIncomplete() {
    const rows = store.listIncomplete(root);
    const recovered = [];
    for (const row of rows) {
      const session = store.getSession(root, row.sessionId);
      if (!session) continue;
      const snap = snapshotKnown(adapter, [...RPH_IMAGES, ...GTA_IMAGES]);
      const rph = findRunning(snap, RPH_IMAGES);
      const gta = findRunning(snap, GTA_IMAGES);
      if (rph || gta) {
        currentId = session.sessionId;
        persist(session, { incomplete: true, state: session.state === SESSION_STATES.CREATED ? SESSION_STATES.INCOMPLETE : session.state });
        startMonitor();
        recovered.push(session.sessionId);
        continue;
      }
      recovered.push(finalize(session.sessionId, { skipWindows: false }).sessionId);
    }
    return recovered;
  }

  return {
    root,
    beginLaunch,
    markLaunching,
    failLaunch,
    observe,
    startMonitor,
    stopMonitor,
    finalize,
    reconcileIncomplete,
    getSession: (id) => store.getSession(root, id || currentId),
    listSessions: () => store.listSessions(root),
    getLatestSession: () => store.getLatestSession(root),
    getRecentSessions: (limit) => store.getRecentSessions(root, limit),
    getSuccessfulSessions: (limit) => store.getSuccessfulSessions(root, limit),
    getFailedSessions: (limit) => store.getFailedSessions(root, limit),
    getSessionsForMod: (installId) => store.getSessionsForMod(root, installId),
    currentId: () => currentId,
  };
}

module.exports = { createSessionManager, newId };
