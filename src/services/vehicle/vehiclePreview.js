const { KINDS, OP_STATUS } = require("./vehicleTypes");

function mark(ok) {
  return ok ? "✓" : "–";
}

function formatVehiclePreview(analysis) {
  if (!analysis || !analysis.detected) {
    return { title: "", sections: [], text: "" };
  }

  const plan = analysis.plan || {};
  const groups = analysis.groups || [];
  const lines = [];
  lines.push("VEHICLE MOD");
  lines.push("");
  lines.push("Type:");
  lines.push(analysis.displayType || analysis.kind || "Vehicle Mod");
  lines.push("");

  if (analysis.kind === KINDS.ADDON_VEHICLE) {
    lines.push("ADD-ON VEHICLE DETECTED");
    lines.push("");
    lines.push(`DLC package:`);
    lines.push((plan.addon && plan.addon.dlcPackage) || "unknown");
    lines.push("");
    lines.push("Required future operations:");
    lines.push("• install DLC package");
    lines.push("• update dlclist.xml");
    lines.push("");
    lines.push("Status:");
    lines.push("Recognized — automatic archive installation not enabled yet.");
  } else {
    for (const group of groups) {
      lines.push("Slot:");
      lines.push(`${group.slot} — ${group.confidence || "UNKNOWN"} confidence`);
      lines.push("");
      lines.push("Assets:");
      lines.push(`${mark(Boolean(group.model))} ${group.slot}.yft`);
      lines.push(`${mark(Boolean(group.highDetailModel))} ${group.slot}_hi.yft`);
      lines.push(`${mark(Boolean(group.texture))} ${group.slot}.ytd`);
      lines.push("");
    }
    const metaNames = (analysis.metas && analysis.metas.files || []).map((m) => m.name);
    if (metaNames.length) {
      lines.push("Metadata:");
      for (const name of [...new Set(metaNames)]) lines.push(name);
      lines.push("");
    }
  }

  const discovered = (analysis.pathResolutions || []).find((row) => row.status === "DISCOVERED");
  if (discovered) {
    const group = groups[0] || { slot: discovered.slot };
    lines.push("ARCHIVE TARGET");
    lines.push("");
    lines.push("Discovered from current GTA V Enhanced installation");
    lines.push("");
    lines.push("Archive:");
    lines.push(discovered.archivePath || discovered.archive || "UNKNOWN");
    lines.push("");
    lines.push("Internal location:");
    lines.push(discovered.entryBase ? `${discovered.entryBase}/` : "UNKNOWN");
    lines.push("");
    lines.push("Evidence:");
    lines.push(`${mark(Boolean(group.model))} ${group.slot}.yft`);
    lines.push(`${mark(Boolean(group.highDetailModel))} ${group.slot}_hi.yft`);
    lines.push(`${mark(Boolean(group.texture))} ${group.slot}.ytd`);
    lines.push("");
    lines.push("Confidence:");
    lines.push(discovered.confidence || "UNKNOWN");
    lines.push("");
    lines.push("Status:");
    lines.push("READ-ONLY DISCOVERY");
    lines.push("");
    lines.push("Vehicle target successfully discovered.");
    lines.push("Native archive installation is not enabled yet.");
  }

  const failedInspect = (analysis.pathResolutions || []).find((row) => row.inspectFailed || row.readError);
  if (!discovered && failedInspect) {
    lines.push("ARCHIVE TARGET");
    lines.push("");
    lines.push("UNKNOWN");
    lines.push("");
    lines.push("Reason: archive could not be inspected");
    if (failedInspect.readError) {
      lines.push("");
      lines.push("ARCHIVE READ ERROR");
    }
  }

  const unknownTargets = (plan.archiveOperations || []).filter((op) => op.status === OP_STATUS.UNKNOWN_TARGET);
  const readyOps = (plan.archiveOperations || []).filter((op) => op.status === OP_STATUS.READY);
  if (!discovered && !failedInspect && unknownTargets.length && !readyOps.length && analysis.kind === KINDS.REPLACE_VEHICLE) {
    const slot = analysis.groups[0] && analysis.groups[0].slot;
    lines.push("ARCHIVE TARGET UNKNOWN");
    lines.push("");
    lines.push(
      `The manager recognizes this as a vehicle replacement, but does not yet have a verified GTA V Enhanced archive location for ${slot}.`
    );
    lines.push("");
    lines.push("No files will be changed.");
  } else if (!discovered && !failedInspect && plan.archiveOperations && plan.archiveOperations.length) {
    lines.push("ARCHIVE PLAN");
    lines.push("");
    const first = plan.archiveOperations[0];
    lines.push("Target:");
    lines.push(first.archive || "UNKNOWN");
    if (first.entry) lines.push(first.entry.replace(/\/[^/]+$/, "/"));
    lines.push("");
    lines.push("Operations:");
    lines.push(`${plan.archiveOperations.length} replacements`);
    lines.push("");
    const state = first.currentState || "UNKNOWN";
    lines.push("Current state:");
    lines.push(state === "VANILLA" ? "Vanilla" : state === "MANAGED_MOD" ? "Managed mod" : state);
    lines.push("");
    lines.push("Status:");
    lines.push("DRY RUN ONLY");
  }

  lines.push("");
  lines.push("This mod type is recognized, but this build cannot yet install encrypted archive modifications automatically.");
  lines.push("Vehicle intelligence is supported. Native archive installation is not enabled yet.");

  if (plan.ownershipConflicts && plan.ownershipConflicts.length) {
    lines.push("");
    for (const conflict of plan.ownershipConflicts) {
      lines.push(conflict.message);
    }
  }

  return {
    title: analysis.displayType,
    kind: analysis.kind,
    archiveRequired: true,
    dryRun: true,
    text: lines.join("\n"),
    sections: lines,
  };
}

module.exports = { formatVehiclePreview };
