# Read-only RPF backend (Phase 3C)

## Selected backend

| Field | Value |
| --- | --- |
| Name | First-party OPEN RPF7 reader |
| Module | `src/services/archive/realRpfBackend.js` |
| Licence | Project MIT. No third-party RPF library. |
| Mode | `READ_ONLY` |
| Writes | Impossible (`NATIVE_RPF_WRITES_NOT_ENABLED`) |
| Isolation | In-process, bounded TOC parse. File handles closed after each operation. A worker/child process is documented for a future crash-prone native decoder; it is not required for header/TOC reads. |

## Capabilities

```json
{
  "read": true,
  "write": false,
  "add": false,
  "replace": false,
  "remove": false,
  "transactional": false,
  "realGtaArchives": true,
  "writeEnabled": false,
  "mode": "READ_ONLY"
}
```

Mock archives still exist for Phase 3A transactions. Real `.rpf` files never use the mock JSON backend.

## Integration

`gtaArchiveService.selectBackend`:

- directory / mock JSON → mock backend
- `.rpf` → real backend, `mode: "readOnly"`

Higher-level services never import a third-party RPF library.

## Security model

- Identify by magic, not extension alone
- Encrypted AES/NG TOC: `ENCRYPTED_RPF_NOT_SUPPORTED` after 16-byte header
- Other magics: `UNSUPPORTED_RPF_VERSION`
- Garbage: `INVALID_RPF`
- Entry names reject `..`
- Caps: 200k entries, 8 MiB names, 32 MiB read, 64 MiB inflate
- Online folder inspection is refused unless `allowOnlineRead`
- No sidecar files inside GTA folders
- Handles opened `fs.openSync(..., "r")` and closed in `finally`

## Index / discovery

`archiveIndex.findEntriesByName` / `findVehicleSlot` search **caller-supplied** archives or a small known Duty candidate set (`x64a.rpf`…`x64w.rpf`, `update/update.rpf`). No full-tree scan.

Co-located `slot.yft` + `slot_hi.yft` + `slot.ytd` → `DISCOVERED` / HIGH.  
Model + texture only → MEDIUM.  
One file → LOW.  
Multiple complete locations → `AMBIGUOUS` (no first-match guess).

Cache: `<dataDir>/archive-discovery-cache.json` keyed by GTA build + archive path/size/mtime + slot. Game update or archive change invalidates. DISCOVERED is never written into `vehicleArchivePaths.json` as VERIFIED.

## Known unsupported variants

- NG/AES encrypted official archives (typical Enhanced `x64*.rpf`)
- RPF0/2/3/4/6/8
- Per-entry encrypted files
- Resource size sentinel `0xFFFFFF` (listed, body size may be unknown)

## Path discovery limitations

Production `vehicleArchivePaths.json` stays empty. Discovery only works on OPEN archives the reader can parse. Encrypted Duty archives yield UNKNOWN with reason “archive could not be inspected”.

## Test fixtures

Tests generate OPEN RPF7 files at runtime via `openRpfFixture.writeOpenRpf7`. Dummy UTF-8 payloads only. No Rockstar assets are in the repository.

## Smoke test

```bash
npm run verify:rpf-readonly
```

Not part of `npm run verify`. Requires a Duty Enhanced folder. Opens the first readable candidate read-only, lists a few entries, asserts SHA-256 unchanged. Encrypted candidates are skipped after proving the hash is unchanged.

## Write-enable gate (later native-write phase must not start until all are true)

Phase 3D researched overlay/DLC alternatives instead of turning this gate on. It remains **off**.

1. Read-only backend stable
2. Enhanced archives proven readable (including encryption policy)
3. Target discovery works on the archives we intend to write
4. Archive hashes unchanged after read-only operations
5. Licence permits the write implementation and commercial distribution
6. Safe full backup strategy exists for real archives
7. Real archive write tests exist on non-GTA fixtures
8. Rollback proven
9. Corruption detection proven
10. `ENABLE_NATIVE_ARCHIVE_WRITES` remains false until the above pass
