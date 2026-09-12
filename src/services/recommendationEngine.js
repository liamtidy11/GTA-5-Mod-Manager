// Converts compatibility + install-integrity signals into one recommendation.
// Does not download, re-enable parked components, or change launch behavior.

const BLOCKING_CONFLICT_CODES = new Set(["online-target", "unsafe-path", "traversal", "PATH_TRAVERSAL", "UNSAFE_DESTINATION"]);

function safetyFinding({ code, status, severity = "INFO", message, why, source = "INSTALL_SAFETY", action = "" }) {
  return { code, status, severity, message, why: why || message, source, action };
}

function conflictCode(item) {
  if (item.code === "online-target") return "UNSAFE_DESTINATION";
  if (item.code === "unsafe-path" || item.code === "traversal") return "PATH_TRAVERSAL";
  if (/protect|xinput|startup|newtonsoft/i.test(`${item.code} ${item.message}`)) return "PROTECTED_FILE";
  return String(item.code || "CONFLICT").toUpperCase();
}

function evaluateInstallSafety({
  conflicts = { severity: "NONE", items: [] },
  security = { ok: true, executables: [], traversal: [] },
  files = [],
  usableCount = null,
  rollbackAvailable = true,
  archiveRequired = false,
  archiveCapabilities = { realGtaArchives: false },
} = {}) {
  const findings = [];
  const items = conflicts.items || [];

  if (security && security.ok === false) {
    findings.push(
      safetyFinding({
        code: "PATH_TRAVERSAL",
        status: "BLOCKED",
        severity: "CRITICAL",
        message: "The package contains paths that escape the install folder.",
        why: "Path traversal is an installation-integrity failure. No files have been changed.",
        source: "ARCHIVE_SECURITY",
      })
    );
  }

  for (const item of items.filter((i) => i.level === "BLOCKED")) {
    findings.push(
      safetyFinding({
        code: conflictCode(item),
        status: "BLOCKED",
        severity: "CRITICAL",
        message: item.message,
        why: "This would write outside the Duty sandbox or overwrite a protected launch file.",
        source: "CONFLICT_DETECTOR",
      })
    );
  }

  for (const item of items.filter((i) => i.level === "HIGH_RISK")) {
    findings.push(
      safetyFinding({
        code: conflictCode(item),
        status: "HIGH_RISK",
        severity: "HIGH",
        message: item.message,
        why: "A high-risk file was skipped or flagged. Remaining files can still be installed transactionally.",
        source: "CONFLICT_DETECTOR",
      })
    );
  }

  const executables = (security && security.executables) || [];
  const installable = (files || []).filter((f) => f.action === "add" || f.action === "replace");
  const usable = usableCount == null ? installable.length : usableCount;

  if (executables.length && installable.length === 0) {
    findings.push(
      safetyFinding({
        code: "EXECUTABLE_REQUIRES_MANUAL_INSTALL",
        status: "BLOCKED",
        severity: "CRITICAL",
        message: "This package is executable-only. Smart Install will not run it.",
        why: "Executables are never launched. There are no other installable files.",
        source: "ARCHIVE_SECURITY",
      })
    );
  } else if (executables.length) {
    findings.push(
      safetyFinding({
        code: "EXECUTABLE_REQUIRES_MANUAL_INSTALL",
        status: "WARNING",
        severity: "MEDIUM",
        message: `${executables.length} executable/script file(s) will not be installed or run.`,
        why: "Executable presence is surfaced for review. It is not labeled malicious.",
        source: "ARCHIVE_SECURITY",
      })
    );
  }

  if (!rollbackAvailable) {
    findings.push(
      safetyFinding({
        code: "NO_ROLLBACK",
        status: "BLOCKED",
        severity: "CRITICAL",
        message: "This install cannot be rolled back if it fails.",
        why: "Smart Install only writes when a transactional rollback path is available.",
        source: "INSTALL_SAFETY",
      })
    );
  } else {
    findings.push(
      safetyFinding({
        code: "ROLLBACK_AVAILABLE",
        status: "SAFE",
        severity: "INFO",
        message: "Rollback is available. A failed copy restores every file this install touched.",
        source: "INSTALL_SAFETY",
      })
    );
  }

  if (usable === 0 && !archiveRequired && !findings.some((f) => f.status === "BLOCKED")) {
    findings.push(
      safetyFinding({
        code: "NOTHING_TO_INSTALL",
        status: "BLOCKED",
        severity: "HIGH",
        message: "No installable files remain after security and protected-file skips.",
        why: "There is nothing safe to copy into the Duty folder.",
        source: "INSTALL_SAFETY",
      })
    );
  }

  const writesEnabled =
    archiveCapabilities &&
    archiveCapabilities.realGtaArchives === true &&
    archiveCapabilities.write === true &&
    archiveCapabilities.writeEnabled === true;
  if (archiveRequired && !writesEnabled) {
    findings.push(
      safetyFinding({
        code: "NATIVE_ARCHIVE_WRITES_UNAVAILABLE",
        status: "UNSUPPORTED",
        severity: "HIGH",
        message: "This mod type is recognized, but this build cannot yet install encrypted archive modifications automatically.",
        why: "Vehicle intelligence is supported. Real encrypted archive installation is not. No files will be changed.",
        source: "ARCHIVE_CAPABILITY",
      })
    );
  }

  let status = "SAFE";
  if (findings.some((f) => f.status === "BLOCKED") || conflicts.severity === "BLOCKED") status = "BLOCKED";
  else if (findings.some((f) => f.status === "UNSUPPORTED")) status = "UNSUPPORTED";
  else if (findings.some((f) => f.status === "HIGH_RISK") || conflicts.severity === "HIGH_RISK") status = "HIGH_RISK";
  else if (findings.some((f) => f.status === "WARNING") || conflicts.severity === "WARNING") status = "WARNING";

  return { status, findings, rollbackAvailable: Boolean(rollbackAvailable) };
}

const REQUIRED_PROBLEMS = new Set([
  "REQUIRED_DEPENDENCY_MISSING",
  "REQUIRED_DEPENDENCY_DISABLED",
  "REQUIRED_DEPENDENCY_TOO_OLD",
  "REQUIRED_DEPENDENCY_INCOMPATIBLE",
  "KNOWN_INCOMPATIBLE_COMPONENT",
  "LOGICAL_CONFLICT",
]);

function requiredDepIssue(dependencies) {
  return (dependencies || []).some(
    (d) =>
      d.kind === "REQUIRED" &&
      ["MISSING", "DISABLED", "VERSION_TOO_OLD", "INCOMPATIBLE"].includes(d.state)
  );
}

function readmeOnlyRequired(dependencies) {
  const required = (dependencies || []).filter((d) => d.kind === "REQUIRED");
  return (
    required.length > 0 &&
    required.every((d) => (d.sources || [d.source]).every((source) => source === "README"))
  );
}

function uniqueReasons(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const text = String(line || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.slice(0, 6);
}

function recommend({
  compatibility = { status: "UNKNOWN", findings: [] },
  installSafety = { status: "SAFE", findings: [] },
  dependencies = [],
  recognition = {},
  duplicate = {},
} = {}) {
  const reasons = [];
  const compatFindings = compatibility.findings || [];
  const safetyFindings = installSafety.findings || [];

  if (installSafety.status === "BLOCKED") {
    for (const item of safetyFindings.filter((f) => f.status === "BLOCKED")) reasons.push(item.message);
    if (!reasons.length) reasons.push("Installation is blocked to protect the Duty folder.");
    return {
      status: "BLOCKED",
      reasons: uniqueReasons(reasons),
      allowOverride: false,
    };
  }

  if (installSafety.status === "UNSUPPORTED") {
    for (const item of safetyFindings.filter((f) => f.status === "UNSUPPORTED")) reasons.push(item.message);
    if (!reasons.length) reasons.push("This mod type is recognized, but this build cannot yet install encrypted archive modifications automatically.");
    return {
      status: "UNSUPPORTED",
      reasons: uniqueReasons(reasons),
      allowOverride: false,
    };
  }

  const highConflict = compatFindings.some(
    (f) => REQUIRED_PROBLEMS.has(f.code) && (f.severity === "HIGH" || f.severity === "CRITICAL" || f.status === "INCOMPATIBLE")
  );
  const incompatible = compatibility.status === "INCOMPATIBLE" || compatFindings.some((f) => f.status === "INCOMPATIBLE");
  const requiredBroken = requiredDepIssue(dependencies) || highConflict;

  if (incompatible || requiredBroken || installSafety.status === "HIGH_RISK") {
    if (incompatible) {
      const hit = compatFindings.find((f) => f.status === "INCOMPATIBLE");
      reasons.push(hit ? hit.message : "Trusted data records a known incompatibility.");
    }
    for (const item of compatFindings.filter((f) => REQUIRED_PROBLEMS.has(f.code))) {
      reasons.push(item.message);
    }
    for (const item of safetyFindings.filter((f) => f.status === "HIGH_RISK")) {
      reasons.push(item.message);
    }
    if (!reasons.length) reasons.push("This package has a concrete runtime or install-risk issue.");
    const gtaUnknown = compatFindings.find((f) => f.code === "GTA_ENHANCED" && f.status === "UNKNOWN");
    if (gtaUnknown) reasons.push(gtaUnknown.message);
    const rollback = safetyFindings.find((f) => f.code === "ROLLBACK_AVAILABLE");
    if (rollback) reasons.push(rollback.message);
    return {
      status: "NOT_RECOMMENDED",
      reasons: uniqueReasons(reasons),
      allowOverride: true,
    };
  }

  const warningBits = [];
  if (compatibility.status === "UNKNOWN" || compatibility.status === "WARNING") {
    const gta = compatFindings.find((f) => f.code === "GTA_ENHANCED");
    if (gta && (gta.status === "UNKNOWN" || gta.status === "WARNING")) warningBits.push(gta.message);
    else if (compatibility.status === "UNKNOWN") {
      warningBits.push("Runtime compatibility has not been verified for this Duty environment.");
    }
  }
  for (const item of compatFindings.filter((f) => f.code === "OPTIONAL_DEPENDENCY_MISSING" || f.code === "REQUIRED_DEPENDENCY_VERSION_UNKNOWN" || f.code === "LOCAL_ENVIRONMENT_WARNING")) {
    warningBits.push(item.message);
  }
  if (readmeOnlyRequired(dependencies)) {
    warningBits.push("Some requirements were detected only from README text, which is untrusted.");
  }
  if (recognition && (recognition.band === "LOW" || recognition.band === "UNKNOWN" || !recognition.modId)) {
    warningBits.push("Mod recognition is low-confidence. Generic install mapping will still be used.");
  }
  if (duplicate && duplicate.alreadyInstalled) {
    warningBits.push(
      duplicate.possibleUpdate
        ? "This package looks like an update to a mod that is already installed."
        : "This mod appears to be already installed."
    );
  }
  for (const item of safetyFindings.filter((f) => f.status === "WARNING")) warningBits.push(item.message);

  const significantUncertainty =
    warningBits.length > 0 ||
    compatibility.status === "UNKNOWN" ||
    compatibility.status === "WARNING" ||
    installSafety.status === "WARNING";

  if (significantUncertainty) {
    return {
      status: "INSTALL_WITH_WARNING",
      reasons: uniqueReasons(warningBits.length ? warningBits : ["Enhanced runtime compatibility is not yet verified."]),
      allowOverride: true,
    };
  }

  reasons.push("Install mapping is understood and rollback is available.");
  if (compatibility.status === "VERIFIED") reasons.push("Trusted data verifies compatibility with this environment.");
  else if (compatibility.status === "LIKELY_COMPATIBLE") reasons.push("No known incompatibilities were found and required dependencies are present.");
  return {
    status: "SAFE_TO_INSTALL",
    reasons: uniqueReasons(reasons),
    allowOverride: false,
  };
}

module.exports = {
  evaluateInstallSafety,
  recommend,
  BLOCKING_CONFLICT_CODES,
};
