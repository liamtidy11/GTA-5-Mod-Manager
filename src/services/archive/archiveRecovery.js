const { appendAudit } = require("../smartAudit");
const { CODES } = require("./archiveErrors");
const { STATES, INTERRUPTED_STATES, listTransactions, persistTransaction } = require("./archiveTransaction");
const backupManager = require("./archiveBackupManager");
const ownership = require("./archiveOwnership");
const mock = require("./mockArchiveBackend");

function needsRecovery(tx) {
  if (!tx || !tx.state) return false;
  if (INTERRUPTED_STATES.includes(tx.state)) return true;
  if (tx.state === STATES.BACKED_UP && tx.interrupted) return true;
  if (tx.state === STATES.BACKED_UP) return true;
  return false;
}

function scanRecovery(dataDir) {
  return listTransactions(dataDir)
    .filter(needsRecovery)
    .map((tx) => ({
      archiveTransactionId: tx.archiveTransactionId,
      state: tx.state,
      action: "RESTORE_BACKUP",
      analysisId: tx.analysisId || "",
      installId: tx.installId || "",
      canonicalModId: tx.canonicalModId || null,
    }));
}

function recover(dataDir, archiveTransactionId) {
  const tx = listTransactions(dataDir).find((row) => row.archiveTransactionId === archiveTransactionId);
  if (!tx || !needsRecovery(tx)) {
    return { action: "NONE", state: tx ? tx.state : null };
  }

  appendAudit(dataDir, "ARCHIVE_RECOVERY_REQUIRED", {
    archiveTransactionId: tx.archiveTransactionId,
    analysisId: tx.analysisId,
    installId: tx.installId,
    canonicalModId: tx.canonicalModId,
    state: tx.state,
  });

  if (!tx.backup || !tx.backup.backupPath) {
    tx.state = STATES.FAILED;
    persistTransaction(dataDir, tx);
    return { action: "RESTORE_BACKUP", state: tx.state, code: CODES.RECOVERY_REQUIRED };
  }

  const restoredOwnership = backupManager.restoreOwnershipSnapshot(tx.backup);
  ownership.saveOwnership(dataDir, restoredOwnership);
  backupManager.restoreArchiveFile(tx.backup);

  let archiveHash = tx.archiveHashBefore;
  try {
    const handle = mock.openArchive(tx.plan.archivePath, { readOnly: true });
    archiveHash = mock.hashOfHandle(handle);
    mock.close(handle);
  } catch {
    /* hash is best-effort after restore */
  }

  tx.state = STATES.ROLLED_BACK;
  tx.interrupted = false;
  tx.archiveHashAfter = archiveHash;
  persistTransaction(dataDir, tx);
  appendAudit(dataDir, "ARCHIVE_ROLLBACK_COMPLETED", {
    archiveTransactionId: tx.archiveTransactionId,
    analysisId: tx.analysisId,
    installId: tx.installId,
    canonicalModId: tx.canonicalModId,
    recovered: true,
  });

  return {
    action: "RESTORE_BACKUP",
    state: tx.state,
    archiveHash,
    archiveTransactionId: tx.archiveTransactionId,
  };
}

function recoverAll(dataDir) {
  return scanRecovery(dataDir).map((row) => recover(dataDir, row.archiveTransactionId));
}

module.exports = { needsRecovery, scanRecovery, recover, recoverAll };
