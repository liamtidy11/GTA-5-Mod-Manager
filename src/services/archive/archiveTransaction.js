const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { appendAudit } = require("../smartAudit");
const { ArchiveError, CODES } = require("./archiveErrors");
const { ENABLE_NATIVE_ARCHIVE_WRITES, mockWritesAllowed } = require("./archiveFlags");
const { isRealRpfPath } = require("./archiveBackend");
const mock = require("./mockArchiveBackend");
const ownership = require("./archiveOwnership");
const backupManager = require("./archiveBackupManager");
const { validateAfterApply } = require("./archiveValidator");

const STATES = {
  PENDING: "PENDING",
  BACKED_UP: "BACKED_UP",
  APPLYING: "APPLYING",
  VALIDATING: "VALIDATING",
  COMMITTED: "COMMITTED",
  ROLLING_BACK: "ROLLING_BACK",
  ROLLED_BACK: "ROLLED_BACK",
  FAILED: "FAILED",
};

const INTERRUPTED_STATES = [STATES.APPLYING, STATES.VALIDATING, STATES.ROLLING_BACK];

function newId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `archive-tx-${Date.now()}`;
}

function transactionsDir(dataDir) {
  return path.join(dataDir, "archive-transactions");
}

function transactionPath(dataDir, archiveTransactionId) {
  return path.join(transactionsDir(dataDir), `${archiveTransactionId}.json`);
}

function persistTransaction(dataDir, tx) {
  if (!dataDir) return tx;
  fs.mkdirSync(transactionsDir(dataDir), { recursive: true });
  fs.writeFileSync(transactionPath(dataDir, tx.archiveTransactionId), JSON.stringify(tx, null, 2), "utf8");
  return tx;
}

function loadTransaction(dataDir, archiveTransactionId) {
  return JSON.parse(fs.readFileSync(transactionPath(dataDir, archiveTransactionId), "utf8"));
}

function listTransactions(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(transactionsDir(dataDir));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(transactionsDir(dataDir), name), "utf8"));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function assertWritesAllowed(archivePath, options = {}) {
  if (isRealRpfPath(archivePath)) {
    throw new ArchiveError(
      CODES.NATIVE_RPF_WRITES_NOT_ENABLED,
      "Native RPF writes are not enabled.",
      { file: archivePath, whatToDo: "Phase 3A does not modify real GTA archives." }
    );
  }
  if (!mockWritesAllowed(options) && ENABLE_NATIVE_ARCHIVE_WRITES !== true) {
    throw new ArchiveError(
      CODES.NATIVE_RPF_WRITES_NOT_ENABLED,
      "Native RPF writes are not enabled.",
      { file: archivePath, whatToDo: "Production cannot obtain real archive-write capability." }
    );
  }
}

function normalizeAction(action) {
  const value = String(action || "").trim().toUpperCase();
  if (value === "ADD" || value === "REPLACE" || value === "REMOVE") return value;
  throw new ArchiveError(CODES.ARCHIVE_ERROR, `Unsupported archive action: ${action}`);
}

function createPlan({
  archivePath,
  operations,
  analysisId = "",
  installId = "",
  canonicalModId = null,
  dataDir = "",
} = {}) {
  mock.rejectRealRpf(archivePath);
  const handle = mock.openArchive(archivePath, { readOnly: true });
  try {
    const identity = mock.identityOfHandle(handle);
    const planned = (operations || []).map((op) => {
      const action = normalizeAction(op.action);
      const entryPath = mock.normalizeEntryPath(op.entryPath);
      const exists = mock.entryExists(handle, entryPath);
      const currentHash = exists ? mock.entryHash(mock.storeEntry(mock.readEntry(handle, entryPath))) : null;
      const sourceBytes = action === "REMOVE" ? null : op.bytes != null ? mock.toBytes(op.bytes) : null;
      return {
        action,
        archivePath,
        entryPath,
        sourceHash: sourceBytes ? mock.entryHash(mock.storeEntry(sourceBytes)) : op.sourceHash || null,
        expectedCurrentHash: op.expectedCurrentHash !== undefined ? op.expectedCurrentHash : currentHash,
        existed: exists,
        bytes: sourceBytes ? mock.storeEntry(sourceBytes) : null,
      };
    });
    const plan = {
      schemaVersion: 1,
      archiveTransactionId: newId(),
      analysisId: analysisId || "",
      installId: installId || "",
      canonicalModId: canonicalModId || null,
      archivePath,
      archiveName: identity.name,
      archiveHash: identity.hash,
      archiveSize: identity.size,
      operations: planned,
      createdAt: new Date().toISOString(),
    };
    if (dataDir) {
      appendAudit(dataDir, "ARCHIVE_PLAN_CREATED", {
        archiveTransactionId: plan.archiveTransactionId,
        analysisId: plan.analysisId,
        installId: plan.installId,
        canonicalModId: plan.canonicalModId,
      });
    }
    return plan;
  } finally {
    mock.close(handle);
  }
}

function assertPlanFresh(handle, plan) {
  const identity = mock.identityOfHandle(handle);
  if (identity.hash !== plan.archiveHash || identity.name !== plan.archiveName) {
    throw new ArchiveError(CODES.STATE_CHANGED, "Archive identity changed after analysis. Re-analyse before applying.", {
      whatToDo: "Create a new archive plan. The previous plan is stale.",
    });
  }
  for (const op of plan.operations || []) {
    const exists = mock.entryExists(handle, op.entryPath);
    const liveHash = exists ? mock.entryHash(mock.storeEntry(mock.readEntry(handle, op.entryPath))) : null;
    if (liveHash !== (op.expectedCurrentHash || null) && (liveHash || op.expectedCurrentHash)) {
      throw new ArchiveError(CODES.STATE_CHANGED, "Archive entry changed after analysis. Re-analyse before applying.", {
        file: op.entryPath,
        whatToDo: "Create a new archive plan. The previous plan is stale.",
      });
    }
    if (op.action === "ADD" && exists && !op.existed) {
      throw new ArchiveError(CODES.STATE_CHANGED, "Archive entry appeared after analysis. Re-analyse before applying.", {
        file: op.entryPath,
      });
    }
  }
}

function applyOne(handle, op) {
  if (op.action === "ADD") {
    mock.addEntry(handle, op.entryPath, op.bytes);
    return "ARCHIVE_ENTRY_ADDED";
  }
  if (op.action === "REPLACE") {
    mock.replaceEntry(handle, op.entryPath, op.bytes);
    return "ARCHIVE_ENTRY_REPLACED";
  }
  mock.removeEntry(handle, op.entryPath);
  return "ARCHIVE_ENTRY_REMOVED";
}

function previousBytesForOp(handle, op) {
  if (!mock.entryExists(handle, op.entryPath)) return null;
  return mock.readEntry(handle, op.entryPath);
}

function applyOwnershipForOp(store, plan, handle, op, installId) {
  const previous = previousBytesForOp(handle, op);
  if (op.action === "REMOVE") {
    ownership.pushOwner(store, plan.archiveName, op.entryPath, installId, null, previous);
    return;
  }
  const nextBytes = mock.toBytes(op.bytes);
  ownership.pushOwner(store, plan.archiveName, op.entryPath, installId, nextBytes, previous);
}

function describeOperations(tx) {
  return (tx.plan.operations || []).map((op) => ({
    archive: tx.plan.archiveName,
    entry: op.entryPath,
    action: op.action,
    previousHash: op.expectedCurrentHash,
    newHash: op.action === "REMOVE" ? null : op.sourceHash,
    transactionId: tx.archiveTransactionId,
  }));
}

function audit(dataDir, event, tx, extra = {}) {
  if (!dataDir) return;
  appendAudit(dataDir, event, {
    archiveTransactionId: tx.archiveTransactionId,
    analysisId: tx.analysisId,
    installId: tx.installId,
    canonicalModId: tx.canonicalModId,
    ...extra,
  });
}

function interrupt(tx, dataDir, stage) {
  tx.interrupted = true;
  tx.interruptStage = stage;
  persistTransaction(dataDir, tx);
  throw new ArchiveError(CODES.INTERRUPTED, `Archive transaction interrupted after ${stage}.`, {
    details: stage,
  });
}

function rollbackNow(tx, dataDir, store, handle, hooks) {
  tx.state = STATES.ROLLING_BACK;
  persistTransaction(dataDir, tx);
  audit(dataDir, "ARCHIVE_ROLLBACK_STARTED", tx);
  if (hooks && hooks.interruptAfter === "ROLLBACK") {
    interrupt(tx, dataDir, "ROLLBACK");
  }
  const restored = backupManager.restoreOwnershipSnapshot(tx.backup);
  ownership.saveOwnership(dataDir, restored);
  backupManager.restoreArchiveFile(tx.backup);
  if (handle && !handle.closed) {
    const reloaded = mock.loadArchiveObject(tx.plan.archivePath);
    mock.replaceArchiveState(handle, reloaded.archive);
    mock.commit(handle);
  }
  tx.state = STATES.ROLLED_BACK;
  tx.archiveHashAfter = tx.archiveHashBefore;
  persistTransaction(dataDir, tx);
  audit(dataDir, "ARCHIVE_ROLLBACK_COMPLETED", tx);
  return restored;
}

function applyPlan(plan, options = {}) {
  const dataDir = options.dataDir;
  const hooks = options.hooks || {};
  assertWritesAllowed(plan.archivePath, options);
  mock.rejectRealRpf(plan.archivePath);

  const tx = {
    schemaVersion: 1,
    archiveTransactionId: plan.archiveTransactionId,
    analysisId: plan.analysisId || "",
    installId: plan.installId || "",
    canonicalModId: plan.canonicalModId || null,
    state: STATES.PENDING,
    plan,
    archiveHashBefore: plan.archiveHash,
    archiveHashAfter: "",
    backup: null,
    interrupted: false,
    createdAt: new Date().toISOString(),
  };
  persistTransaction(dataDir, tx);

  const handle = mock.openArchive(plan.archivePath);
  const store = options.ownershipOverride
    ? ownership.cloneOwnership(options.ownershipOverride)
    : ownership.loadOwnership(dataDir);
  const ownershipBefore = ownership.cloneOwnership(ownership.loadOwnership(dataDir));
  const skipLiveOwnership = !!options.ownershipOverride;
  try {
    assertPlanFresh(handle, plan);
    const beforeEntries = mock.snapshotEntries(handle);
    tx.backup = backupManager.createBackup({
      dataDir,
      archiveTransactionId: tx.archiveTransactionId,
      handle,
      ownershipStore: ownershipBefore,
    });
    tx.state = STATES.BACKED_UP;
    persistTransaction(dataDir, tx);
    audit(dataDir, "ARCHIVE_BACKUP_CREATED", tx, { backupPath: tx.backup.backupPath });

    if (hooks.interruptAfter === "BACKUP") {
      interrupt(tx, dataDir, "BACKUP");
    }

    tx.state = STATES.APPLYING;
    persistTransaction(dataDir, tx);
    audit(dataDir, "ARCHIVE_APPLY_STARTED", tx);

    for (let i = 0; i < plan.operations.length; i += 1) {
      if (hooks.failAtOperation === i + 1) {
        throw new ArchiveError(CODES.ARCHIVE_ERROR, `Forced failure on archive operation ${i + 1}.`);
      }
      const op = plan.operations[i];
      if (!skipLiveOwnership) {
        applyOwnershipForOp(store, plan, handle, op, plan.installId || tx.installId);
      }
      const event = applyOne(handle, op);
      mock.commit(handle);
      audit(dataDir, event, tx, { entry: op.entryPath, action: op.action });
      if (i === 0 && hooks.interruptAfter === "FIRST_WRITE") {
        interrupt(tx, dataDir, "FIRST_WRITE");
      }
    }

    tx.state = STATES.VALIDATING;
    persistTransaction(dataDir, tx);
    if (hooks.interruptAfter === "VALIDATION") {
      interrupt(tx, dataDir, "VALIDATION");
    }
    if (hooks.failValidate) {
      throw new ArchiveError(CODES.VALIDATION_FAILED, "Forced archive validation failure.");
    }
    validateAfterApply(handle, plan, beforeEntries);
    audit(dataDir, "ARCHIVE_VALIDATED", tx);

    ownership.saveOwnership(dataDir, store);
    tx.archiveHashAfter = mock.hashOfHandle(handle);
    tx.state = STATES.COMMITTED;
    persistTransaction(dataDir, tx);
    audit(dataDir, "ARCHIVE_COMMITTED", tx);
    return {
      ok: true,
      archiveTransactionId: tx.archiveTransactionId,
      state: tx.state,
      archiveHashBefore: tx.archiveHashBefore,
      archiveHashAfter: tx.archiveHashAfter,
      archiveOperations: describeOperations(tx),
      transaction: tx,
    };
  } catch (error) {
    if (error instanceof ArchiveError && error.code === CODES.INTERRUPTED) {
      throw error;
    }
    if (error instanceof ArchiveError && error.code === CODES.STATE_CHANGED && tx.state === STATES.PENDING) {
      tx.state = STATES.FAILED;
      persistTransaction(dataDir, tx);
      throw error;
    }
    try {
      rollbackNow(tx, dataDir, store, handle, hooks);
    } catch (rollbackError) {
      if (rollbackError instanceof ArchiveError && rollbackError.code === CODES.INTERRUPTED) {
        throw rollbackError;
      }
      tx.state = STATES.FAILED;
      persistTransaction(dataDir, tx);
      throw rollbackError;
    }
    throw error;
  } finally {
    mock.close(handle);
  }
}

function applyOwnerRelease({
  dataDir,
  archivePath,
  entryPath,
  installId,
  analysisId = "",
  canonicalModId = null,
  allowMockWrites,
  hooks,
} = {}) {
  assertWritesAllowed(archivePath, { allowMockWrites });
  mock.rejectRealRpf(archivePath);
  const key = mock.normalizeEntryPath(entryPath);
  const peek = mock.openArchive(archivePath, { readOnly: true });
  const archiveName = peek.name;
  const exists = mock.entryExists(peek, key);
  const liveHash = exists ? mock.entryHash(mock.storeEntry(mock.readEntry(peek, key))) : null;
  mock.close(peek);

  const disk = ownership.loadOwnership(dataDir);
  const rec = ownership.getRecord(disk, archiveName, key);
  ownership.assertNotExternallyModified(rec, liveHash, key);

  const nextStore = ownership.cloneOwnership(disk);
  const released = ownership.releaseOwner(nextStore, archiveName, key, installId);
  if (released.action !== "RESTORE") {
    ownership.saveOwnership(dataDir, nextStore);
    return { ok: true, action: released.action, archiveOperations: [] };
  }

  if (released.restore.absent && !exists) {
    ownership.saveOwnership(dataDir, nextStore);
    return { ok: true, action: "RESTORE", archiveOperations: [] };
  }

  const op = released.restore.absent
    ? { action: "REMOVE", archivePath, entryPath: key }
    : {
        action: exists ? "REPLACE" : "ADD",
        archivePath,
        entryPath: key,
        bytes: ownership.layerContent(released.restore),
      };

  const plan = createPlan({
    archivePath,
    operations: [op],
    analysisId,
    installId,
    canonicalModId,
    dataDir,
  });
  return applyPlan(plan, {
    dataDir,
    allowMockWrites,
    hooks,
    ownershipOverride: nextStore,
  });
}

module.exports = {
  STATES,
  INTERRUPTED_STATES,
  persistTransaction,
  loadTransaction,
  listTransactions,
  transactionPath,
  assertWritesAllowed,
  createPlan,
  applyPlan,
  applyOwnerRelease,
  describeOperations,
  rollbackNow,
};
