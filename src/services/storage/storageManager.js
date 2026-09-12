const fs = require("fs");
const path = require("path");
const { folderSize } = require("../profiles/managedState");
const snapshotStore = require("../snapshots/snapshotStore");
const { RETENTION } = require("../snapshots/snapshotTypes");
const manifestStore = require("../manifestStore");
const payloadStore = require("../payloadStore");

// Storage usage + SAFE cleanup. Never deletes data the user may need to
// recover: active payloads, known-good rollback payloads, pinned or known-good
// snapshots, or pending crash-action state.

function usage(context = {}) {
  const dataDir = context.dataDir || "";
  const payloads = folderSize(path.join(dataDir, "store"));
  const backups = folderSize(path.join(dataDir, "backups"));
  const snapshots = folderSize(context.snapshotRoot || "");
  const sessions = folderSize(context.sessionRoot || "");
  const profiles = folderSize(context.profileRoot || "");
  const staging = folderSize(context.stagingRoot || "");
  const total = payloads + backups + snapshots + sessions + profiles + staging;
  return { payloads, backups, snapshots, sessions, profiles, staging, total };
}

function walkFiles(dir, predicate) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (predicate(abs)) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = 0;
        }
        out.push({ path: abs, bytes: size });
      }
    }
  }
  return out;
}

function protectedItems(context = {}) {
  const items = [];
  // Pinned + known-good snapshots.
  for (const snap of snapshotStore.listSnapshots(context.snapshotRoot || "")) {
    if (snap.pinned || snap.knownGood) items.push(`snapshot:${snap.snapshotId}`);
  }
  // Active payload for each installed manifest.
  for (const manifest of manifestStore.list(context.dataDir || "")) {
    if (fs.existsSync(payloadStore.storeRoot(context.dataDir, manifest.id))) items.push(`payload:${manifest.id}`);
  }
  // Pending crash-action state.
  if (context.actionRoot && fs.existsSync(context.actionRoot)) {
    try {
      for (const name of fs.readdirSync(context.actionRoot)) {
        if (name.toLowerCase().endsWith(".json")) items.push(`crash-action:${name}`);
      }
    } catch {
      /* ignore */
    }
  }
  return items;
}

function planCleanup(context = {}) {
  const candidates = [];
  const guard = new Set(protectedItems(context));

  // Old unpinned automatic snapshots beyond retention.
  const snaps = snapshotStore
    .listSnapshots(context.snapshotRoot || "")
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const autos = snaps.filter((s) => s.reason !== "MANUAL" && !s.pinned && !s.knownGood);
  for (const snap of autos.slice(RETENTION.AUTOMATIC)) {
    const id = `snapshot:${snap.snapshotId}`;
    if (guard.has(id)) continue;
    candidates.push({
      id,
      kind: "OLD_AUTOMATIC_SNAPSHOT",
      bytes: folderSize(snapshotStore.snapshotDir(context.snapshotRoot, snap.snapshotId)) + fileBytes(snapshotStore.snapshotFile(context.snapshotRoot, snap.snapshotId)),
      reason: `Automatic snapshot from ${String(snap.createdAt).slice(0, 10)} beyond the keep-${RETENTION.AUTOMATIC} limit.`,
      path: snapshotStore.snapshotFile(context.snapshotRoot, snap.snapshotId),
    });
  }

  // Abandoned staging folders.
  if (context.stagingRoot && fs.existsSync(context.stagingRoot)) {
    try {
      for (const name of fs.readdirSync(context.stagingRoot)) {
        const abs = path.join(context.stagingRoot, name);
        candidates.push({
          id: `staging:${name}`,
          kind: "ABANDONED_STAGING",
          bytes: folderSize(abs),
          reason: "Leftover Smart Install staging folder.",
          path: abs,
        });
      }
    } catch {
      /* ignore */
    }
  }

  // Stale temp files anywhere in the manager data dir.
  for (const file of walkFiles(context.dataDir || "", (abs) => /\.(tmp|smarttmp)$/i.test(abs))) {
    candidates.push({
      id: `temp:${file.path}`,
      kind: "STALE_TEMP",
      bytes: file.bytes,
      reason: "Stale temporary file.",
      path: file.path,
    });
  }

  return { candidates, protected: [...guard] };
}

function fileBytes(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function applyCleanup(context = {}, ids = []) {
  const wanted = new Set(ids);
  const { candidates } = planCleanup(context);
  const guard = new Set(protectedItems(context));
  const removed = [];
  let freedBytes = 0;
  for (const candidate of candidates) {
    if (!wanted.has(candidate.id)) continue;
    if (guard.has(candidate.id)) continue; // never remove protected data
    try {
      if (candidate.kind === "OLD_AUTOMATIC_SNAPSHOT") {
        const snapshotId = candidate.id.slice("snapshot:".length);
        snapshotStore.deleteSnapshot(context.snapshotRoot, snapshotId);
      } else if (candidate.kind === "ABANDONED_STAGING") {
        fs.rmSync(candidate.path, { recursive: true, force: true });
      } else if (candidate.kind === "STALE_TEMP") {
        fs.rmSync(candidate.path, { force: true });
      }
      removed.push(candidate.id);
      freedBytes += candidate.bytes || 0;
    } catch {
      /* skip anything that fails to delete */
    }
  }
  return { removed, freedBytes };
}

module.exports = { usage, planCleanup, applyCleanup, protectedItems };
