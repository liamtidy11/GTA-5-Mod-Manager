# Smart Install V3 — Archive architecture (Phase 3A)

Phase 3A adds a **mock-only** archive abstraction on top of Smart Install V2. It proves inspect → plan → backup → transaction → modify → validate → commit → rollback without touching a real GTA `.rpf`.

V3 extends V2. It does not replace analysis ids, manifests, stale-state protection, audit, or filesystem transactions. See `docs/smart-install-v2.md`.

Phase 3C adds a **read-only** first-party OPEN RPF7 backend. Real archive **writes** remain disabled. There is no OpenIV integration and no third-party RPF library. See `docs/rpf-readonly-backend.md` and `docs/rpf-backend-evaluation.md`.

## Backend contract

Application code talks to `src/services/archive/gtaArchiveService.js`, which delegates to a backend that implements:

| Operation | Purpose |
| --- | --- |
| `openArchive(path)` | Open a mock archive handle |
| `listEntries(handle)` | Sorted entry paths |
| `entryExists(handle, entryPath)` | Membership |
| `readEntry(handle, entryPath)` | Entry bytes |
| `getEntryMetadata(handle, entryPath)` | Path, size, SHA-256, exists |
| `addEntry(handle, entryPath, bytes)` | Insert |
| `replaceEntry(handle, entryPath, bytes)` | Overwrite |
| `removeEntry(handle, entryPath)` | Delete |
| `validate(handle)` | Structure check |
| `commit(handle)` | Persist mock archive |
| `close(handle)` | Drop the handle |

Capabilities for the mock backend:

```json
{
  "read": true,
  "write": true,
  "add": true,
  "replace": true,
  "remove": true,
  "transactional": true,
  "realGtaArchives": false
}
```

`realGtaArchives` is `false` on the mock backend. Phase 3C adds a read-only real backend; `gtaArchiveService.getCapabilities()` reports `realGtaArchives: true` and `write: false`. Mock transactions still use the nested `mock` capabilities.

## Mock representation

A mock archive is JSON with `kind: "MOCK_GTA_ARCHIVE"`:

```text
tests/fixtures/archives/vehicles/archive.json
  name: vehicles.rpf
  x64/levels/gta5/vehicles/police.yft
  x64/levels/gta5/vehicles/police_hi.yft
  x64/levels/gta5/vehicles/police.ytd
```

Directories that contain `archive.json` are valid mock roots. Dummy text only — no GTA assets.

Deterministic archive hash: SHA-256 over `name` plus sorted `entryPath + entry SHA-256` rows.

Paths ending in `.rpf` are routed to the Phase 3C read-only backend (magic-checked, never trusted by extension alone). Writes still return `NATIVE_RPF_WRITES_NOT_ENABLED`. The mock backend still refuses `.rpf` if called directly.

## Transaction states

Persisted under `<dataDir>/archive-transactions/<archiveTransactionId>.json`.

```text
PENDING → BACKED_UP → APPLYING → VALIDATING → COMMITTED
                         ↘ ROLLING_BACK → ROLLED_BACK
Any unexpected failure after backup → ROLLING_BACK → ROLLED_BACK
Unrecoverable persist failure → FAILED
```

Every transaction carries `archiveTransactionId` plus V2 fields when known: `analysisId`, `installId`, `canonicalModId`, `schemaVersion: 1`.

## Read-only plan

`createPlan` opens the archive read-only, records archive identity/hash, per-entry `expectedCurrentHash`, and `sourceHash`. It does not add, replace, or remove entries.

Apply rechecks identity and entry hashes. Mismatch returns `STATE_CHANGED` and requires a new plan. Analysis stays read-only, matching V2.

## Backup strategy

Before mutation, the full mock archive and the ownership store are copied to:

```text
<dataDir>/archive-backups/<archiveTransactionId>/
  archive.json
  ownership.json
  meta.json
```

`meta.json` records original archive hash, original size, backup path, `createdAt`, and `transactionId`. Phase 3A prefers a full mock-archive copy over incremental patches.

## Ownership stack

Stored at `<dataDir>/archive-ownership.json`.

The first time an entry is managed, the current bytes are recorded as `VANILLA`. Later installs push onto the stack:

```text
VANILLA → install-a → install-b
```

Removing the top owner restores the previous owner's bytes. Removing the final owner restores `VANILLA`. Content for each layer is kept so a later phase can unwind layers in order.

If the live entry hash does not match the active owner's recorded hash, the entry is `EXTERNALLY_MODIFIED` and is not overwritten.

## Rollback

If validation fails, or operation *N* of *M* fails, the mock archive is replaced from the backup. The deterministic archive hash and the ownership store must match the pre-transaction snapshot. All-or-nothing: a failure on operation 13 of 20 restores the exact tree.

## Recovery

Transactions left in `APPLYING`, `VALIDATING`, `ROLLING_BACK`, or interrupted `BACKED_UP` are treated as interrupted.

`scanRecovery(dataDir)` returns `{ action: "RESTORE_BACKUP" }`.
`recover(dataDir, archiveTransactionId)` copies the backup archive and ownership snapshot back, then marks `ROLLED_BACK`.

Tests simulate interruption after backup, after the first write, during validation, and during rollback. There is no production UI for this yet.

## Manifest integration

V2 manifests (`schemaVersion: 1`) may now include `archiveOperations`:

```json
{
  "archive": "vehicles.rpf",
  "entry": "vehicles/police.yft",
  "action": "REPLACE",
  "previousHash": "...",
  "newHash": "...",
  "transactionId": "..."
}
```

Phase 3A only writes these from mock/test data. Filesystem Smart Install commits still preserve an existing list (or start empty). Malformed manifests still become `MANIFEST_ERROR`.

## Audit

Archive events are appended to the existing V2 `smart-audit.jsonl`:

`ARCHIVE_PLAN_CREATED` · `ARCHIVE_BACKUP_CREATED` · `ARCHIVE_APPLY_STARTED` · `ARCHIVE_ENTRY_ADDED` · `ARCHIVE_ENTRY_REPLACED` · `ARCHIVE_ENTRY_REMOVED` · `ARCHIVE_VALIDATED` · `ARCHIVE_COMMITTED` · `ARCHIVE_ROLLBACK_STARTED` · `ARCHIVE_ROLLBACK_COMPLETED` · `ARCHIVE_RECOVERY_REQUIRED`

Rows include `archiveTransactionId` plus the V2 id fields when present.

## Feature flag

`ENABLE_NATIVE_ARCHIVE_WRITES` is hardcoded `false` in `src/services/archive/archiveFlags.js`.

- Production apply without `{ allowMockWrites: true }` → `NATIVE_RPF_WRITES_NOT_ENABLED`
- Real `.rpf` writes are impossible; there is no real backend
- Tests pass `{ allowMockWrites: true }` for fixtures only
- `process.env` is never used to enable native writes

## V2 integration

Archive transactions reuse:

- `schemaVersion`
- `analysisId` / `installId` / `canonicalModId`
- stale-state `STATE_CHANGED`
- audit + rollback semantics
- manifest validation

They do not write Duty, Online, or launch files. Unit tests use temp fixtures only.

## Real RPF backend (Phase 3C)

Read-only OPEN RPF7 support is documented in `docs/rpf-readonly-backend.md`. Encrypted official Enhanced archives are identified and refused (`ENCRYPTED_RPF_NOT_SUPPORTED`). Real writes remain impossible.

Phase 3D did **not** enable writes. It evaluated safer overlay/DLC layers; none are licence-clear to ship. See `docs/enhanced-mod-layer-evaluation.md`. Native encrypted writes remain rejected until a lawful key source exists.

## Limitations (Phase 3A–3D)

- No real RPF writer
- No vehicle installer, meta merger, EUP, weapons, or audio
- No OpenIV
- Production cannot enable native archive writes
- Recovery is programmatic only (no dedicated UI)
- Official encrypted archives cannot be listed or read yet
