// Suggests (never auto-applies) marking a profile as known-good once it has a
// track record of clean sessions.

function cleanSessionCount(profileId, sessions = []) {
  return (sessions || []).filter((s) => s.profileId === profileId && s.result === "CLEAN_EXIT").length;
}

function lastCrash(profileId, sessions = []) {
  const failed = (sessions || []).filter(
    (s) => s.profileId === profileId && ["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH"].includes(s.result)
  );
  return failed.length ? failed[0].startedAt || failed[0].endedAt || null : null;
}

function recommend(profile, sessions = [], { threshold = 5 } = {}) {
  if (!profile) return { suggest: false };
  const clean = cleanSessionCount(profile.profileId, sessions);
  if (profile.knownGood) {
    return { suggest: false, knownGood: true, cleanSessions: clean };
  }
  if (clean >= threshold) {
    return {
      suggest: true,
      cleanSessions: clean,
      message: `${profile.name} has ${clean} clean sessions. Consider marking it known-good.`,
    };
  }
  return { suggest: false, cleanSessions: clean };
}

module.exports = { recommend, cleanSessionCount, lastCrash };
