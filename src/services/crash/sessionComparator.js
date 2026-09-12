const { CLEAN_RESULTS, FAILED_RESULTS } = require("./crashTypes");

function enabledMods(session) {
  return (session.mods || []).filter((mod) => mod.enabled !== false);
}

function overlayOn(session) {
  const overlays = session.overlays || {};
  const launch = overlays.atLaunch || {};
  return Boolean(
    overlays.nvidiaDetected ||
      launch.nvidiaOverlay ||
      launch.nvidiaShare ||
      (session.processes &&
        session.processes.atLaunch &&
        session.processes.atLaunch.some((row) => row.running && /nvidia overlay|nvidia share|rtss|afterburner/i.test(row.image)))
  );
}

function overlayNames(session) {
  const names = [];
  const launch = (session.overlays && session.overlays.atLaunch) || {};
  if (launch.nvidiaOverlay || launch.nvidiaShare || (session.overlays && session.overlays.nvidiaDetected)) {
    names.push("NVIDIA Overlay");
  }
  const procs = (session.processes && session.processes.atLaunch) || [];
  for (const row of procs) {
    if (!row.running) continue;
    if (/NVIDIA Overlay|NVIDIA Share/i.test(row.image)) names.push("NVIDIA Overlay");
    if (/RTSS/i.test(row.image)) names.push("RTSS");
    if (/MSIAfterburner/i.test(row.image)) names.push("MSI Afterburner");
    if (/RazerCortex/i.test(row.image)) names.push("Razer Cortex");
  }
  return [...new Set(names)];
}

function compareSessions(target, history = []) {
  const others = (history || []).filter((row) => row && row.sessionId !== target.sessionId);
  const clean = others
    .filter((row) => CLEAN_RESULTS.has(row.result))
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const failed = others
    .filter((row) => FAILED_RESULTS.has(row.result))
    .sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const lastClean = [...clean].reverse().find((row) => !target.startedAt || String(row.startedAt) <= String(target.startedAt)) || clean[clean.length - 1] || null;
  const firstFailed = failed[0] || (FAILED_RESULTS.has(target.result) ? target : null);

  const targetMods = enabledMods(target);
  const lastCleanMods = lastClean ? enabledMods(lastClean) : [];
  const lastCleanIds = new Set(lastCleanMods.map((mod) => mod.installId));
  const newlyEnabled = targetMods.filter((mod) => !lastCleanIds.has(mod.installId));
  const versionChanges = [];
  for (const mod of targetMods) {
    const prior = lastCleanMods.find((row) => row.installId === mod.installId);
    if (prior && prior.version && mod.version && prior.version !== mod.version) {
      versionChanges.push({ installId: mod.installId, name: mod.name, from: prior.version, to: mod.version });
    }
  }

  return {
    clean,
    failed,
    lastClean,
    firstFailed,
    newlyEnabled,
    versionChanges,
    overlayOn: overlayOn(target),
    overlayNames: overlayNames(target),
    lastCleanOverlayOn: lastClean ? overlayOn(lastClean) : false,
    gtaChanged: Boolean(lastClean && env(lastClean, "gtaVersion") !== env(target, "gtaVersion")),
    rphChanged: Boolean(lastClean && env(lastClean, "rphVersion") !== env(target, "rphVersion")),
    lspdfrChanged: Boolean(lastClean && env(lastClean, "lspdfrVersion") !== env(target, "lspdfrVersion")),
    lastCleanEnv: lastClean
      ? {
          gtaVersion: env(lastClean, "gtaVersion"),
          rphVersion: env(lastClean, "rphVersion"),
          lspdfrVersion: env(lastClean, "lspdfrVersion"),
        }
      : null,
    targetEnv: {
      gtaVersion: env(target, "gtaVersion"),
      rphVersion: env(target, "rphVersion"),
      lspdfrVersion: env(target, "lspdfrVersion"),
    },
    sample: { clean: clean.length, failed: failed.length + (FAILED_RESULTS.has(target.result) ? 1 : 0) },
  };
}

function env(session, key) {
  return (session.environment && session.environment[key]) || "UNKNOWN";
}

function modPresence(installId, history) {
  let clean = 0;
  let failed = 0;
  const versions = {};
  for (const session of history || []) {
    const hit = (session.mods || []).find((mod) => mod.installId === installId && mod.enabled !== false);
    if (!hit) continue;
    const key = hit.version || "UNKNOWN";
    versions[key] = versions[key] || { clean: 0, failed: 0 };
    if (CLEAN_RESULTS.has(session.result)) {
      clean += 1;
      versions[key].clean += 1;
    } else if (FAILED_RESULTS.has(session.result)) {
      failed += 1;
      versions[key].failed += 1;
    }
  }
  return { clean, failed, versions };
}

module.exports = { compareSessions, enabledMods, overlayOn, overlayNames, modPresence };
