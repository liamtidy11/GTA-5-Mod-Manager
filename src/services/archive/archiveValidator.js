const { ArchiveError, CODES } = require("./archiveErrors");
const { entryExists, readEntry, validate, entryHash, storeEntry, normalizeEntryPath } = require("./mockArchiveBackend");

function validateAfterApply(handle, plan, beforeEntries) {
  validate(handle);

  for (const op of plan.operations || []) {
    const entryPath = normalizeEntryPath(op.entryPath);
    if (op.action === "REMOVE") {
      if (entryExists(handle, entryPath)) {
        throw new ArchiveError(CODES.VALIDATION_FAILED, "Removed archive entry is still present.", { file: entryPath });
      }
      continue;
    }
    if (!entryExists(handle, entryPath)) {
      throw new ArchiveError(CODES.VALIDATION_FAILED, "Expected archive entry is missing.", { file: entryPath });
    }
    const liveHash = entryHash(storeEntry(readEntry(handle, entryPath)));
    if (op.sourceHash && liveHash !== op.sourceHash) {
      throw new ArchiveError(CODES.VALIDATION_FAILED, "Replacement hash does not match the plan.", { file: entryPath });
    }
  }

  const planned = new Set((plan.operations || []).map((op) => normalizeEntryPath(op.entryPath)));
  for (const [entryPath, stored] of Object.entries(beforeEntries || {})) {
    if (planned.has(entryPath)) continue;
    if (!entryExists(handle, entryPath)) {
      throw new ArchiveError(CODES.VALIDATION_FAILED, "Unrelated archive entry was removed.", { file: entryPath });
    }
    const liveHash = entryHash(storeEntry(readEntry(handle, entryPath)));
    if (liveHash !== entryHash(stored)) {
      throw new ArchiveError(CODES.VALIDATION_FAILED, "Unrelated archive entry changed.", { file: entryPath });
    }
  }

  for (const entryPath of Object.keys(handle.archive.entries || {})) {
    if (planned.has(entryPath) || Object.prototype.hasOwnProperty.call(beforeEntries || {}, entryPath)) continue;
    throw new ArchiveError(CODES.VALIDATION_FAILED, "Unexpected archive entry appeared.", { file: entryPath });
  }

  return { ok: true };
}

module.exports = { validateAfterApply };
