const { SESSION_RESULTS, CONFIDENCE } = require("./sessionTypes");

function classifyExit(input = {}) {
  const evidence = [];
  const push = (type, source, message) => evidence.push({ type, source, message });

  if (input.managerTerminated) {
    push("MANAGER_ACTION", "manager", "Manager requested process termination for this session.");
    return {
      result: SESSION_RESULTS.TERMINATED,
      confidence: CONFIDENCE.HIGH,
      evidence,
    };
  }

  if (input.launchFailed) {
    push("LAUNCH_FAILED", "launcher", input.launchFailedMessage || "RPH or GTA never reached the expected launch state.");
    return {
      result: SESSION_RESULTS.LAUNCH_FAILED,
      confidence: input.rphSeen || input.gtaSeen ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH,
      evidence,
    };
  }

  const signals = input.signals || {};
  if (signals.lspdfrFailed && (input.rphExited || input.gtaExited || input.reachedActive)) {
    push("LOG_EVENT", "RagePluginHook.log", "LSPDFR or plugin failure is recorded in the session log.");
    return {
      result: SESSION_RESULTS.LSPDFR_CRASH,
      confidence: signals.lspdfrFailed && input.rphSeen ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
      evidence,
    };
  }

  if (signals.rphException || (input.rphExitedFirst && input.gtaStillRunning && !signals.cleanShutdown)) {
    push("PROCESS_EXIT", "RagePluginHook.exe", "RPH exited while GTA remained active or the RPH log recorded a fatal exception.");
    return {
      result: SESSION_RESULTS.RPH_CRASH,
      confidence: signals.rphException || input.rphExitedFirst ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
      evidence,
    };
  }

  if (signals.gameCrash || (input.windowsFaultingApp && /gta5_enhanced/i.test(input.windowsFaultingApp))) {
    push("LOG_EVENT", input.windowsFaultingApp || "GTA5_Enhanced.exe", "A game crash marker or Windows application error is present.");
    return {
      result: SESSION_RESULTS.GAME_CRASH,
      confidence: signals.gameCrash || input.windowsFaultingApp ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
      evidence,
    };
  }

  if (input.gtaExitedFirst && !signals.cleanShutdown && !input.reachedActive) {
    push("PROCESS_EXIT", "GTA5_Enhanced.exe", "GTA exited before a stable session was observed.");
    return {
      result: SESSION_RESULTS.LAUNCH_FAILED,
      confidence: CONFIDENCE.MEDIUM,
      evidence,
    };
  }

  if (signals.cleanShutdown && input.rphExited && input.gtaExited) {
    push("LOG_EVENT", "RagePluginHook.log", "Known shutdown sequence is present and both processes exited.");
    return {
      result: SESSION_RESULTS.CLEAN_EXIT,
      confidence: CONFIDENCE.HIGH,
      evidence,
    };
  }

  if (input.reachedActive && input.rphExited && input.gtaExited && !signals.rphException && !signals.gameCrash && !signals.lspdfrFailed) {
    push("PROCESS_EVENT", "session", "Both processes exited after an active session with no crash markers.");
    return {
      result: SESSION_RESULTS.CLEAN_EXIT,
      confidence: CONFIDENCE.MEDIUM,
      evidence,
    };
  }

  if (input.rphExited && input.gtaExited) {
    push("PROCESS_EVENT", "session", "Processes exited without enough evidence for a specific result.");
    return {
      result: SESSION_RESULTS.UNKNOWN,
      confidence: CONFIDENCE.LOW,
      evidence,
    };
  }

  push("UNKNOWN", "session", "Evidence is insufficient to classify this exit.");
  return {
    result: SESSION_RESULTS.UNKNOWN,
    confidence: CONFIDENCE.UNKNOWN,
    evidence,
  };
}

module.exports = { classifyExit };
