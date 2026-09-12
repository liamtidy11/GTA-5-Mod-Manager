const PATTERNS = {
  LSPDFR_LOADING: /Loading plugin from path:.*LSPD First Response\.dll/i,
  LSPDFR_LOADED: /Plugin "LSPD First Response\.dll" was loaded|LSPD First Response\.dll".*loaded successfully/i,
  LSPDFR_FAILED: /Failed to load plugin.*LSPD First Response|LSPD First Response.*Unhandled exception/i,
  RPH_EXCEPTION: /RagePluginHook(?:\.exe)?.{0,80}(unhandled exception|fatal error|has crashed)/i,
  GAME_CRASH: /The game has crashed|Game process (?:has )?(?:exited unexpectedly|terminated unexpectedly|crashed)/i,
  CLEAN_SHUTDOWN: /Unloading plugins|Plugin hook is shutting down|Normal shutdown/i,
};

function scanLogText(text) {
  const blob = String(text || "");
  return {
    lspdfrLoading: PATTERNS.LSPDFR_LOADING.test(blob),
    lspdfrLoaded: PATTERNS.LSPDFR_LOADED.test(blob),
    lspdfrFailed: PATTERNS.LSPDFR_FAILED.test(blob),
    rphException: PATTERNS.RPH_EXCEPTION.test(blob) || /Unhandled exception in Rage Plugin Hook/i.test(blob),
    gameCrash: PATTERNS.GAME_CRASH.test(blob),
    cleanShutdown: PATTERNS.CLEAN_SHUTDOWN.test(blob),
    empty: !blob.trim(),
    malformed: blob.includes("\u0000"),
  };
}

module.exports = { PATTERNS, scanLogText };
