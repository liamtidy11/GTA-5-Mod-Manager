// Pure filters for Launch History. No IO.

const FILTERS = ["All", "Clean", "Crash", "Unknown", "Profile", "Mod"];
const FAILED = new Set(["GAME_CRASH", "RPH_CRASH", "LSPDFR_CRASH", "LAUNCH_FAILED"]);

function filterSessions(sessions = [], { type = "All", profileId = "", installId = "" } = {}) {
  const rows = sessions || [];
  switch (type) {
    case "Clean":
      return rows.filter((s) => s.result === "CLEAN_EXIT");
    case "Crash":
      return rows.filter((s) => FAILED.has(s.result));
    case "Unknown":
      return rows.filter((s) => s.result === "UNKNOWN" || s.result == null || s.incomplete === true);
    case "Profile":
      return rows.filter((s) => (profileId ? s.profileId === profileId : Boolean(s.profileId)));
    case "Mod":
      return rows.filter((s) => (s.mods || []).some((m) => (m.installId === installId || m.id === installId) && m.enabled !== false));
    case "All":
    default:
      return rows.slice();
  }
}

module.exports = { FILTERS, FAILED, filterSessions };
