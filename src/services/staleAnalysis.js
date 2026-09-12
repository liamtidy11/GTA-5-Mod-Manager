const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { exists, isEnhancedFolder } = require("./paths");
const { safeHashFileSync } = require("./hashUtil");
const { fingerprintPath } = require("./packageFingerprint");
const { SmartInstallError } = require("./smartErrors");

function processRunning(image) {
  try {
    const out = execFileSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/NH"], {
      windowsHide: true,
      encoding: "utf8",
    });
    return new RegExp(image.replace(/\./g, "\\."), "i").test(out);
  } catch {
    return false;
  }
}

function replaceHashes(dutyPath, files) {
  const map = {};
  for (const file of files || []) {
    if (file.action !== "replace") continue;
    const abs = path.join(dutyPath, String(file.destination || "").split("/").join(path.sep));
    map[String(file.destination).replace(/\\/g, "/")] = safeHashFileSync(abs);
  }
  return map;
}

function snapshotEnvironment({ dutyPath, officialPath, source, payloadRoot, files }) {
  return {
    dutyPath: dutyPath ? path.resolve(dutyPath) : "",
    officialPath: officialPath ? path.resolve(officialPath) : "",
    sourceArchiveHash: fingerprintPath(source),
    stagedHash: fingerprintPath(payloadRoot),
    replaceHashes: replaceHashes(dutyPath, files),
  };
}

function revalidate(preview, { dutyPath, officialPath = "", checkRunning = true } = {}) {
  const snap = preview && preview.environmentSnapshot;
  if (!preview || !snap) {
    throw new SmartInstallError("STATE_CHANGED", "The Duty installation changed after this preview was created.", {
      whatToDo: "Please review the updated installation preview.",
    });
  }
  if (!dutyPath || !isEnhancedFolder(dutyPath)) {
    throw new SmartInstallError("DESTINATION_ERROR", "The Duty (LSPDFR) folder is not set up.", {
      whatToDo: "Create the LSPDFR folder in Setup, then analyze the pack again.",
    });
  }
  if (officialPath && path.resolve(dutyPath).toLowerCase() === path.resolve(officialPath).toLowerCase()) {
    throw new SmartInstallError("DESTINATION_ERROR", "The install target is the clean Online folder.", {
      whatToDo: "Smart Install never writes there. Choose the LSPDFR folder.",
    });
  }
  if (path.resolve(dutyPath).toLowerCase() !== String(snap.dutyPath || "").toLowerCase()) {
    throw new SmartInstallError("STATE_CHANGED", "The Duty installation changed after this preview was created.", {
      whatToDo: "Please review the updated installation preview.",
    });
  }
  const stagedNow = fingerprintPath(preview.payloadRoot);
  if (!stagedNow || stagedNow !== snap.stagedHash) {
    throw new SmartInstallError("STATE_CHANGED", "The staged package no longer matches the analyzed archive.", {
      whatToDo: "Drop the archive again so Smart Install can re-analyze it.",
    });
  }
  if (preview.source && exists(preview.source)) {
    const sourceNow = fingerprintPath(preview.source);
    if (snap.sourceArchiveHash && sourceNow && sourceNow !== snap.sourceArchiveHash) {
      throw new SmartInstallError("STATE_CHANGED", "The dropped package changed after this preview was created.", {
        whatToDo: "Please review the updated installation preview.",
      });
    }
  }
  const current = replaceHashes(dutyPath, preview.files);
  for (const [dest, hash] of Object.entries(snap.replaceHashes || {})) {
    if ((current[dest] || null) !== (hash || null)) {
      throw new SmartInstallError("STATE_CHANGED", "The Duty installation changed after this preview was created.", {
        file: dest,
        whatToDo: "Please review the updated installation preview.",
      });
    }
  }
  const writes = (preview.files || []).some((f) => f.action === "add" || f.action === "replace");
  if (checkRunning && writes && (processRunning("GTA5_Enhanced.exe") || processRunning("RagePluginHook.exe"))) {
    throw new SmartInstallError(
      "DESTINATION_ERROR",
      "GTA V or RAGE Plugin Hook is running, so files cannot be replaced safely.",
      {
        whatToDo: "Close GTA V and RAGE Plugin Hook, then try again.",
      }
    );
  }
  try {
    fs.accessSync(dutyPath, fs.constants.W_OK);
  } catch {
    throw new SmartInstallError("TRANSACTION_ERROR", "The Duty folder is not writable, so rollback cannot be guaranteed.", {
      whatToDo: "Check folder permissions, then review the preview again.",
    });
  }
  return { ok: true };
}

module.exports = { snapshotEnvironment, revalidate, processRunning, replaceHashes };
