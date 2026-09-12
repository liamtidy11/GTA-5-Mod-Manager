const fs = require("fs");
const path = require("path");

// Config preservation for updates/reinstalls. Preview-only until commit.
// Default KEEP_EXISTING where a user-editable config already exists.

const POLICIES = ["KEEP_EXISTING", "USE_NEW_DEFAULT", "REVIEW_CHANGES"];
const CONFIG_EXT = new Set([".ini", ".json", ".xml", ".cfg"]);

function isConfigFile(rel) {
  const ext = path.extname(String(rel || "")).toLowerCase();
  return CONFIG_EXT.has(ext);
}

function snippet(text, limit = 1200) {
  return String(text || "").replace(/\r\n/g, "\n").slice(0, limit);
}

function lineDiff(existing, incoming, max = 20) {
  const left = String(existing || "").replace(/\r\n/g, "\n").split("\n");
  const right = String(incoming || "").replace(/\r\n/g, "\n").split("\n");
  const changes = [];
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n && changes.length < max; i += 1) {
    if (left[i] === right[i]) continue;
    changes.push({
      line: i + 1,
      existing: left[i] == null ? "" : left[i],
      incoming: right[i] == null ? "" : right[i],
    });
  }
  return { changed: changes.length > 0, lines: changes, truncated: n > max && changes.length >= max };
}

function readText(abs) {
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function applyConfigPolicy(files, { dutyPath, payloadRoot, policy = "KEEP_EXISTING" } = {}) {
  const chosen = POLICIES.includes(policy) ? policy : "KEEP_EXISTING";
  const diffs = [];
  const out = (files || []).map((file) => {
    const dest = file.destination || "";
    if (!isConfigFile(dest)) return { ...file };
    const destAbs = dutyPath ? path.join(dutyPath, dest.split("/").join(path.sep)) : "";
    const srcAbs = payloadRoot ? path.join(payloadRoot, String(file.source || "").split("/").join(path.sep)) : "";
    let destExists = false;
    try {
      destExists = Boolean(destAbs) && fs.existsSync(destAbs);
    } catch {
      destExists = false;
    }
    const next = { ...file, config: true, configPolicy: chosen };
    if (destExists && srcAbs && fs.existsSync(srcAbs)) {
      const existing = readText(destAbs);
      const incoming = readText(srcAbs);
      diffs.push({
        destination: dest,
        existing: snippet(existing),
        incoming: snippet(incoming),
        diff: lineDiff(existing, incoming),
      });
    }
    if (chosen === "KEEP_EXISTING" && destExists && (file.action === "replace" || file.action === "add")) {
      next.action = "skip";
      next.reason = "Existing configuration kept (KEEP_EXISTING).";
    }
    if (chosen === "USE_NEW_DEFAULT" && destExists) {
      next.action = "replace";
      next.reason = next.reason || "Incoming default configuration will replace the existing file.";
    }
    return next;
  });
  return { files: out, configPolicy: chosen, configDiffs: diffs };
}

module.exports = { POLICIES, isConfigFile, applyConfigPolicy, lineDiff };
