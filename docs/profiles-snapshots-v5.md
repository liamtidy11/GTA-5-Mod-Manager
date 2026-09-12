# Profiles and snapshots (V5)

V5 lets you experiment with LSPDFR and still have a safe way home. Profiles describe how you **want** Duty configured. Snapshots remember how Duty **was** configured.

This is personal-use only. There is no cloud sync, profile sharing, marketplace, accounts, payments, or telemetry.

Launch, BattlEye, Online, and Smart Install transactions are unchanged. V5 never copies the whole GTA tree and never writes into the official Online folder.

## Two models

| | Profiles | Snapshots |
| --- | --- | --- |
| Purpose | Named setups you switch between on purpose | Recovery points for managed state at a moment in time |
| Created | User (or one-time migration) | Manual, or automatically before risky changes |
| Switching | Planned, confirmed, transactional | Restore is planned, confirmed, transactional |
| Missing package | Profile stays; switch is refused | Restore is refused |
| Drift | Active profile can become drifted | Snapshot stays frozen |

Neither silently modifies Online.

## Profile model

Stored under `userData/profiles/`:

- `index.json` — `activeProfileId`, `knownGoodProfileId`, drift flags
- `<profileId>/profile.json`
- `<profileId>/configs/` — hashed copies of **managed** config files only

```json
{
  "schemaVersion": 1,
  "profileId": "uuid",
  "name": "Stable Patrol",
  "createdAt": "...",
  "updatedAt": "...",
  "description": "",
  "mods": [
    {
      "installId": "...",
      "canonicalModId": "...",
      "version": "...",
      "enabled": true
    }
  ],
  "configs": [{ "installId": "...", "destination": "plugins/LSPDFR/example.ini", "hash": "..." }],
  "launchPreferences": {},
  "knownGood": false,
  "drifted": false
}
```

Profiles reference managed installs. They do not duplicate mod payloads.

On first V5 run, if no profiles exist, the manager imports **Current Setup** from the live managed state. Migration does not enable, disable, or rewrite Duty files.

Suggested names such as Stable Patrol and Testing are optional. They are not created automatically when a setup already exists.

## Snapshot model

Stored under `userData/snapshots/`:

- `index.json`
- `<snapshotId>.json`
- `blobs/` — config bytes keyed by hash (deduplicated)
- `<snapshotId>/payloads/<installId>/<version>/` — copy of the Smart Install payload store for that version, not the game folder

```json
{
  "schemaVersion": 1,
  "snapshotId": "uuid",
  "name": "...",
  "createdAt": "...",
  "reason": "MANUAL",
  "environment": { "gtaVersion": "...", "rphVersion": "...", "lspdfrVersion": "..." },
  "mods": [],
  "configs": [],
  "protectedFiles": []
}
```

Reasons: `MANUAL`, `BEFORE_PROFILE_SWITCH`, `BEFORE_UPDATE`, `BEFORE_DOWNGRADE`, `BEFORE_CRASH_ACTION`, `BEFORE_REPAIR`.

Automatic snapshots are created before managed updates/downgrades, profile switches, crash-action tests, and major repairs. Not for every UI click.

## Transactions

Profile switch and snapshot restore are all-or-nothing.

1. Refuse Online targets (`ONLINE_TARGET_REJECTED`).
2. Refuse while GTA Enhanced or RPH is running (`GAME_RUNNING`). The manager does not kill them.
3. Build a read-only plan (enable / disable / restore version / restore config).
4. Refuse incomplete plans instead of inventing files.
5. Apply operations through existing `setEnabled`, payload, and config restore paths.
6. If any operation fails, reverse completed work. The managed-state hash must match the pre-attempt hash.

A failed switch does not become the active profile.

## Versions and missing packages

If a profile wants Stop The Ped 1.7, current is 1.8, and a 1.7 payload still exists (current store or a snapshot payload), the plan includes a version restore.

If the package is gone:

```
PROFILE INCOMPLETE

Stop The Ped 1.7 is required but the package is no longer available.
```

The manager does not fake restoration.

If a profile `installId` no longer exists, that row stays on the profile as missing. It is not silently deleted. Health becomes `INCOMPLETE` and switch is refused.

## Configs

Only Smart Install–owned config files (`.ini`, `.json`, `.xml`, `.cfg` already on a managed manifest) are captured. Arbitrary GTA `.ini` files are ignored.

If a captured file changed on disk after the profile was saved, switch shows:

```
CONFIG CHANGED OUTSIDE MOD MANAGER

plugins/LSPDFR/example.ini

Current file differs from the profile version.
```

Overwrite requires confirmation. Silent overwrite does not happen.

Identical config bytes are stored once by hash when the blob store is used.

## Health

- **HEALTHY** — referenced mods and payloads are available; no broken state
- **WARNING** — unknown compatibility or recorded drift
- **INCOMPLETE** — missing required mod or version payload
- **BROKEN** — unreadable / corrupt profile metadata

Compatibility counts reuse the existing dependency/compatibility services. V5 does not reimplement them.

## Known-good

The user marks **Set as Known Good**. Only one known-good profile is kept. Session history can show supporting evidence (clean sessions, stable runtime). The manager never auto-promotes a profile from runtime alone.

**Restore Known-Good Setup** still shows the switch plan. It is not a blind mutation.

## Drift

If Duty no longer matches the active profile (enable/disable, version, or a newly installed managed mod), the profile is **drifted**. Crash actions and Smart Install mark drift. They do not rewrite the profile.

The user chooses:

- **Update Profile** — capture current managed state into the profile
- **Restore Profile** — switch back to the saved profile (planned)
- **Ignore for now**

A newly installed mod is not auto-added to the active profile.

## Retention

Defaults: keep 10 unpinned manual snapshots and 15 unpinned automatic snapshots. Pinned and known-good snapshots are excluded from cleanup. Manual snapshots are not deleted just because an automatic prune ran.

The Recovery page shows approximate profile + snapshot folder size.

## Session and crash integration

Each V4A launch session stores `profileId` and optional `snapshotId`.

V4B may add a low-score `RECENT_CHANGE` finding when several failures occurred on this profile and several clean exits occurred on others. That is correlation, not proof.

V4C test actions snapshot first (best effort), then mark the active profile drifted. After the test, restore the profile if you want the saved setup back.

## Guards

- Target must be the Duty (Enhanced sandbox) folder.
- Online path, or Duty === Online, is rejected.
- Running `GTA5_Enhanced` / `RagePluginHook` blocks switch and restore.

## Limitations

- Profiles do not clone missing mods from the internet.
- Version restore needs a stored payload. No payload means incomplete, not a guess.
- Snapshots are not full-disk images. Unmanaged files in the Duty folder are outside this system.
- Environment version drift on a snapshot is a warning, not an automatic lockout.
- This build does not share, sell, or sync profiles.

## Audit events

`PROFILE_CREATED`, `PROFILE_UPDATED`, `PROFILE_SWITCH_STARTED`, `PROFILE_SWITCH_COMPLETED`, `PROFILE_SWITCH_ROLLED_BACK`, `PROFILE_MARKED_KNOWN_GOOD`, `SNAPSHOT_CREATED`, `SNAPSHOT_RESTORE_STARTED`, `SNAPSHOT_RESTORED`, `SNAPSHOT_RESTORE_ROLLED_BACK`, `SNAPSHOT_PINNED`, `SNAPSHOT_DELETED`.
