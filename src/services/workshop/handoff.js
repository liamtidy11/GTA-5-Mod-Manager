const { compact } = require("./catalog");

function buildHandoff(entry, extras = {}) {
  if (!entry) return null;
  return {
    expectedCanonicalModId: entry.canonicalModId || entry.id,
    expectedName: entry.name,
    provider: extras.provider || entry.provider || entry.source,
    providerFileId: extras.providerFileId || entry.providerFileId || null,
    sourceVersion: extras.sourceVersion || entry.sourceVersion || "",
    workshopId: entry.workshopId,
  };
}

function recognitionIdentity(preview = {}) {
  const recognition = preview.recognition || {};
  return {
    canonicalModId: recognition.modId || preview.canonicalModId || "",
    name: recognition.name || preview.name || "",
    confidence: Number(recognition.confidence || 0),
    band: String(recognition.band || "").toUpperCase(),
  };
}

function identitiesMatch(expected, detected) {
  const exp = compact(expected);
  const got = compact(detected);
  if (!exp || !got) return false;
  return exp === got || exp.includes(got) || got.includes(exp);
}

function evaluateHandoff({ expected = null, preview = {} } = {}) {
  if (!expected) return { status: "NONE", mismatch: false, weak: false, message: "" };
  const detected = recognitionIdentity(preview);
  const expectedId = expected.expectedCanonicalModId || expected.canonicalModId || "";
  const expectedName = expected.expectedName || expected.name || "";
  const matched =
    identitiesMatch(expectedId, detected.canonicalModId) || identitiesMatch(expectedName, detected.name);
  const weak = !detected.canonicalModId || detected.band === "LOW" || detected.band === "WEAK" || detected.band === "UNKNOWN" || detected.confidence < 0.6;

  if (!detected.canonicalModId && weak) {
    return {
      status: "UNKNOWN",
      mismatch: false,
      weak: true,
      expectedName: expectedName || expectedId,
      detectedName: detected.name || "Unknown package",
      message: "Smart Install could not confidently recognize this download. Review the preview before installing.",
    };
  }
  if (!matched && detected.canonicalModId) {
    return {
      status: "MISMATCH",
      mismatch: true,
      weak: false,
      expectedName: expectedName || expectedId,
      detectedName: detected.name || detected.canonicalModId,
      message: `DOWNLOAD DOES NOT MATCH SELECTED MOD\nExpected:\n${expectedName || expectedId}\nDetected:\n${detected.name || detected.canonicalModId}\nDo not install unless you intentionally selected this file.`,
    };
  }
  return {
    status: "MATCH",
    mismatch: false,
    weak,
    expectedName: expectedName || expectedId,
    detectedName: detected.name || detected.canonicalModId,
    message: weak ? "Recognition is weak. Confirm this is the file you meant to download." : "",
  };
}

module.exports = { buildHandoff, evaluateHandoff, recognitionIdentity };
