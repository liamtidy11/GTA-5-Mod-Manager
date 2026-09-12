// Normalize errors for the normal UI. Internal codes stay in developer mode.

function formatUserError(error) {
  if (error && typeof error.formatUser === "function") return error.formatUser();
  const raw = error && error.message ? String(error.message) : String(error || "Something went wrong.");
  if (/what happened/i.test(raw) || /INSTALLATION FAILED/.test(raw) || /PROFILE INCOMPLETE/.test(raw) || /CONFIG CHANGED OUTSIDE/.test(raw)) {
    return raw;
  }
  return [
    "What happened",
    raw,
    "",
    "Why it matters",
    "The last action did not finish, so Duty was left as it was (or rolled back).",
    "",
    "What you can do",
    "Try again. If Duty looks wrong, use Recovery or Restore Known-Good Setup.",
  ].join("\n");
}

module.exports = { formatUserError };
