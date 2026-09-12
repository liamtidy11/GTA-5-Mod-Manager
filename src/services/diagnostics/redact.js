// Redacts personal paths and secrets from diagnostic output. Personal-use
// tool, but a report should still be safe to paste into a forum.

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redact(text, { home = "", username = "" } = {}) {
  let out = String(text == null ? "" : text);

  // Windows user profile paths: C:\Users\<name>\... -> C:\Users\<USER>\...
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\/\r\n"']+/g, "$1<USER>");
  // POSIX-style home: /Users/<name> or /home/<name>
  out = out.replace(/(\/(?:Users|home)\/)[^\\/\r\n"']+/g, "$1<USER>");

  if (home) {
    const forward = home.replace(/\\/g, "/");
    for (const variant of [home, forward]) {
      out = out.replace(new RegExp(escapeRegExp(variant), "gi"), "<HOME>");
    }
  }
  if (username) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(username)}\\b`, "gi"), "<USER>");
  }

  // Obvious secrets: token=..., password: ..., api_key "...", bearer ...
  out = out.replace(/\b(token|password|passwd|secret|api[_-]?key|auth)\b(\s*[:=]\s*)("?)([^\s"']+)\3/gi, "$1$2$3<REDACTED>$3");
  out = out.replace(/\b(bearer)\s+[A-Za-z0-9._-]+/gi, "$1 <REDACTED>");

  return out;
}

// Deep-redact every string in a JSON-serialisable value.
function redactDeep(value, options = {}) {
  if (value == null) return value;
  if (typeof value === "string") return redact(value, options);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options));
  if (typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = redactDeep(inner, options);
    return out;
  }
  return value;
}

module.exports = { redact, redactDeep };
