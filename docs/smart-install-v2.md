# Smart Install V2

Filesystem-only mod manager for the Duty folder (`Grand Theft Auto V Enhanced - LSPDFR`). Analysis is read-only. Only explicit commit / enable / disable / uninstall / repair write managed files. The Online Steam folder is never a write target.

This document is the V2 completion record and the contract V3 may extend. V3 must not replace these objects.

## Pipeline

```text
Archive security
→ Staging (outside Duty)
→ Scan
→ Classification
→ Recognition
→ Environment Inventory (cached)
→ README evidence
→ Dependency resolution
→ Compatibility
→ Install safety
→ Recommendation
→ Preview
→ Commit (only write stage)
```

Analyze never writes GTA files, never enables or disables components, never repairs Duty, and never changes manifests.

## Analysis object

| Field | Meaning |
| --- | --- |
| `analysisId` | Unique id for this preview |
| `installId` / `id` | Install instance id (reused on update/reinstall) |
| `canonicalModId` | Knowledge id, or `null` if unknown |
| `createdAt` | ISO timestamp |
| `analysisVersion` | Currently `1` |
| `sourceArchive` | Dropped file/folder name |
| `sourceArchiveHash` | SHA-256 fingerprint of the drop |
| `environmentSnapshot` | Duty path, staged hash, replace-target hashes |
| `recognition` | Identity, band, signals, candidates, `ambiguous` |
| `resolvedDependencies` | Dependency results |
| `compatibility` | `{ status, confidence, findings }` |
| `installSafety` | `{ status, findings }` |
| `recommendation` | `{ status, reasons, allowOverride }` |
| `duplicate` | `{ relation: NEW\|SAME\|UPDATE\|DOWNGRADE\|UNKNOWN }` |
| `configPolicy` | `KEEP_EXISTING` (default), `USE_NEW_DEFAULT`, `REVIEW_CHANGES` |
| `files` | Planned copies with actions |

## Recommendation states

- `SAFE_TO_INSTALL` — mapping understood, rollback available, required deps OK
- `INSTALL_WITH_WARNING` — unknown compatibility or other non-blocking uncertainty
- `NOT_RECOMMENDED` — required dep missing/disabled, trusted incompatibility (override with confirm)
- `BLOCKED` — integrity/security only (Online target, traversal, no rollback). No override

UNKNOWN compatibility is not BLOCKED.

## Dependency states

`INSTALLED` · `MISSING` · `DISABLED` · `BUNDLED` · `VERSION_TOO_OLD` · `VERSION_TOO_NEW` · `UNKNOWN` · `INCOMPATIBLE`

Parked Script Hook V / Script Hook V .NET stay `DISABLED`. They are never re-enabled automatically.

Evidence sources, highest first: `APP_MANIFEST` → `KNOWLEDGE_DATABASE` → `PACKAGE_METADATA` → `README`.

## Compatibility vs install safety

Compatibility is runtime likelihood. Install safety is whether the copy/rollback can proceed. A pack can be `Compatibility: UNKNOWN` and `Install safety: SAFE`.

## Manifest

Stored at `<dataDir>/manifests/<installId>.json`. `schemaVersion` is `1`. Loader validates; malformed manifests become `MANIFEST_ERROR` and are not auto-deleted.

Important fields: `installId`, `canonicalModId`, `analysisId`, `sourceArchiveHash`, `version`, `files[].hash`, `configPolicy`, `history`, `compatibilityStatus`.

Backups: `<dataDir>/backups/<installId>/`.
Repair copies: `<dataDir>/store/<installId>/`.
Audit: `<dataDir>/smart-audit.jsonl`.
Local metrics: `<dataDir>/smart-metrics.json`.

## Transactions

Commit either finishes completely or restores the pre-install tree. Failures after the first write roll back in reverse. If rollback cannot finish, the error category is `ROLLBACK_ERROR`.

Stale previews are rejected (`STATE_CHANGED`) when Duty replace-targets, staged bytes, or the Duty path change after analyze.

## Current limitations

- No native RPF / OpenIV writes
- No automatic downloads
- Built-in knowledge compatibility rows stay UNKNOWN unless independently verified
- Repair can only restore files that were stored at commit time
- Smart Install is still opt-in (preview toggle), not the default installer

## V3 contract

V3 may rely on, and must not replace:

- the analysis object above
- `canonicalModId` / `installId` / `analysisId`
- dependency, compatibility, install-safety, and recommendation results
- transactional commit + rollback conventions
- manifest `schemaVersion` and file ownership hashes
- backup and payload-store layout

V3 archive writes should be additional transaction steps behind the same preview/recommendation/safety gate.

Phase 3A mock archive architecture is documented in `docs/smart-install-v3-archive-architecture.md`. Phase 3B vehicle intelligence is documented in `docs/smart-install-v3-vehicle-intelligence.md`. Phase 3C is read-only OPEN RPF7. Phase 3D found no licence-clear Enhanced overlay (`docs/enhanced-mod-layer-evaluation.md`). These extend this contract and do not replace it.
