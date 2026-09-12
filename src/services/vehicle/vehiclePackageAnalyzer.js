const { groupVehicleAssets, isVehicleArchiveAsset } = require("./vehicleAssetGrouper");
const { detectSlots } = require("./vehicleSlotDetector");
const { detectMetadata } = require("./vehicleMetaDetector");
const { extractReadmeEvidence } = require("./vehicleReadmeEvidence");
const { classifyVehicle } = require("./vehicleClassifier");
const { resolveSlot } = require("./archivePathResolver");
const { planVehicleInstall } = require("./vehicleInstallPlanner");
const { formatVehiclePreview } = require("./vehiclePreview");

function analyzeVehiclePackage(scan, options = {}) {
  const files = (scan && scan.usableFiles) || [];
  const readme = extractReadmeEvidence(scan);
  const grouped = groupVehicleAssets(files);
  const slots = detectSlots({ files, readmeSlots: readme.slots });

  for (const group of grouped.groups) {
    const detected = slots.find((s) => s.slot === group.slot);
    if (detected) {
      group.confidence = detected.confidence;
      group.slotEvidence = detected.evidence;
    }
    if (readme.slots.some((r) => r.slot === group.slot) && group.confidence !== "HIGH") {
      group.slotEvidence = [...(group.slotEvidence || []), ...readme.slots.filter((r) => r.slot === group.slot)];
    }
  }

  const classification = classifyVehicle({ groups: grouped.groups, files, readme });
  const metas = detectMetadata(
    files,
    grouped.groups.map((g) => g.slot)
  );

  const pathResolutions = grouped.groups.map((group) =>
    resolveSlot(group.slot, {
      pathMap: options.pathMap,
      archiveIndex: options.archiveIndex,
      discoverOptions: options.discoverOptions,
      discovery: options.discovery,
    })
  );

  const analysis = {
    detected: classification.detected,
    kind: classification.kind,
    displayType: classification.displayType,
    archiveRequired: Boolean(classification.archiveRequired),
    groups: grouped.groups,
    warnings: grouped.warnings,
    slots,
    metas,
    readme,
    classification,
    pathResolutions,
    files,
  };

  const plan = classification.detected
    ? planVehicleInstall({
        analysis,
        pathMap: options.pathMap,
        archiveIndex: options.archiveIndex,
        discoverOptions: options.discoverOptions,
        dataDir: options.dataDir,
        mockArchivePath: options.mockArchivePath,
        capabilities: options.capabilities,
        dutyPath: options.dutyPath,
        officialPath: options.officialPath,
        layer: options.layer,
      })
    : {
        mode: "DRY_RUN",
        applied: false,
        archiveRequired: false,
        archiveOperations: [],
        capability: "UNSUPPORTED",
      };

  analysis.plan = plan;
  analysis.preview = formatVehiclePreview(analysis);
  return analysis;
}

function applyArchiveRequiredGuard(files, analysis) {
  if (!analysis || !analysis.archiveRequired) return files;
  return (files || []).map((file) => {
    if (!isVehicleArchiveAsset(file.source || file.rel || file.destination)) return file;
    return {
      ...file,
      action: "skip",
      archiveRequired: true,
      severity: "WARNING",
      reason: "Requires a GTA archive destination. Not copied into the Duty folder.",
    };
  });
}

function applyGenericInstallerArchiveGuard(copies = []) {
  const kept = [];
  const removed = [];
  for (const copy of copies) {
    const from = copy.from || copy.source || "";
    const to = copy.to || copy.destination || "";
    if (isVehicleArchiveAsset(from) || isVehicleArchiveAsset(to)) removed.push(copy);
    else kept.push(copy);
  }
  return {
    copies: kept,
    removed,
    archiveRequired: removed.length > 0,
    reason:
      removed.length && !kept.length
        ? "Native GTA archive writing is not enabled in this build. Vehicle models are not copied into the Duty folder."
        : "",
  };
}

module.exports = {
  analyzeVehiclePackage,
  applyArchiveRequiredGuard,
  applyGenericInstallerArchiveGuard,
  isVehicleArchiveAsset,
};
