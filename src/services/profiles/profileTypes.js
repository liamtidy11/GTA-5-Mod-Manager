const SCHEMA_VERSION = 1;

const HEALTH = {
  HEALTHY: "HEALTHY",
  WARNING: "WARNING",
  INCOMPLETE: "INCOMPLETE",
  BROKEN: "BROKEN",
};

const CODES = {
  ONLINE_TARGET_REJECTED: "ONLINE_TARGET_REJECTED",
  GAME_RUNNING: "GAME_RUNNING",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  NOT_SAFE: "NOT_SAFE",
};

const AUDIT_EVENTS = [
  "PROFILE_CREATED",
  "PROFILE_UPDATED",
  "PROFILE_SWITCH_STARTED",
  "PROFILE_SWITCH_COMPLETED",
  "PROFILE_SWITCH_ROLLED_BACK",
  "PROFILE_MARKED_KNOWN_GOOD",
];

class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProfileError";
  }
}

module.exports = { SCHEMA_VERSION, HEALTH, CODES, AUDIT_EVENTS, ProfileError };
