# Smart Install V3 — Vehicle intelligence (Phase 3B)

Phase 3B teaches the manager to **understand** vehicle packages and produce a **read-only dry-run archive plan**. It does not write real GTA archives.

V2 filesystem installs and Phase 3A mock archive transactions remain the baseline. See `docs/smart-install-v2.md` and `docs/smart-install-v3-archive-architecture.md`.

## What this phase does

A dropped vehicle pack can be answered with:

- Is this a vehicle mod, and which kind?
- Replacement, add-on, pack, unknown, or ambiguous?
- Which slots and `.yft` / `_hi.yft` / `.ytd` groups exist?
- Which metadata files are present?
- What archive entry would eventually change?
- Is that target verified, unknown, or ambiguous?
- What ownership / external conflicts exist?
- What would the archive transaction look like?

None of those answers apply a transaction. `plan.applied` is always `false`.

## Vehicle classification

| Kind | Display name | Meaning |
| --- | --- | --- |
| `REPLACE_VEHICLE` | Vehicle Replacement | One known vanilla-style slot (for example `police3.yft`) and no stronger add-on structure |
| `ADDON_VEHICLE` | Add-On Vehicle | `dlc.rpf` / `content.xml` / `setup2.xml` / `dlcpacks/` structure |
| `VEHICLE_PACK` | Vehicle Pack | Multiple vehicle groups |
| `UNKNOWN_VEHICLE_MOD` | Vehicle Mod | Vehicle assets exist but the slot is not a known vanilla replacement |
| `AMBIGUOUS_VEHICLE_PACKAGE` | Ambiguous Vehicle Package | Replacement-style assets and add-on structure in the same tree without a clear split |

Classification is not permission to install.

## Asset grouping

Files are grouped by filename stem:

```text
police3.yft          → model
police3_hi.yft       → highDetailModel
police3.ytd          → texture
```

Incomplete groups are allowed. Missing `_hi.yft` or `.ytd` is a warning, not a crash. Duplicate slot files and multiple textures for one slot are also warnings.

## Slot detection

Confidence: `HIGH` · `MEDIUM` · `LOW` · `UNKNOWN`.

- Exact known filenames (`police`, `police2`, `police3`, `police4`, `sheriff`, `sheriff2`, `fbi`, `fbi2`, `riot`, `pranger`, `ambulance`, `firetruk`) → **HIGH**
- Folder named after a known slot → **MEDIUM**
- README “replace police3” / “install as police2” → **MEDIUM** (or **LOW** if the name is not a known slot)
- Custom `mycustom.yft` → **UNKNOWN** (the stem is recorded; it is not guessed as a vanilla slot)

Filename evidence beats README. The architecture is not limited to the known emergency list.

## Metadata

Detected by name, not merged or written:

`vehicles.meta` · `handling.meta` · `carvariations.meta` · `carcols.meta` · `dlclist.xml` · `content.xml` · `setup2.xml`

If the pack has a single slot, or the meta sits in a folder named for that slot, it is associated. Otherwise it stays package-level. Duplicate meta names are reported.

## Path resolver

`archivePathResolver` answers “where would this eventually go?” It does not modify anything.

States: `VERIFIED` · `DISCOVERED` · `AMBIGUOUS` · `UNKNOWN` · `UNSUPPORTED`.

Production map (`src/data/vehicleArchivePaths.json`):

```json
{
  "schemaVersion": 1,
  "edition": "Enhanced",
  "vehicleSlots": {}
}
```

**No production Enhanced paths are shipped.** Unknown is correct. Legacy GTA V paths are not copied in.

Tests inject `tests/fixtures/vehicle-paths/mock-enhanced.json`. That file is not production truth.

`discoverSlotInIndex` still accepts a test-injected fake index. Phase 3C also runs targeted read-only discovery (`archiveIndex`) against caller-supplied or known Duty candidate archives. DISCOVERED is never written into the production map as VERIFIED.

A filesystem `.rpf` may be opened **read-only** by the Phase 3C OPEN RPF7 backend. Encrypted official archives return `ENCRYPTED_RPF_NOT_SUPPORTED`. Writes still return `NATIVE_RPF_WRITES_NOT_ENABLED`. A mapping **name** such as `vehicles.rpf` is not treated as a file to open.

## Dry-run planner

`vehicleInstallPlanner` builds:

```text
mode: DRY_RUN
applied: false
capability: UNSUPPORTED   (because writeEnabled is false)
archiveOperations[]
```

Replacement ops include `READY` / `UNKNOWN_TARGET` / `AMBIGUOUS_TARGET` / `CONFLICT` / `UNSUPPORTED`.

Add-on plans do not invent vehicle-archive replacements. They record future work: install DLC package, update `dlclist.xml`.

The planner never calls `applyPlan`.

## Ownership and conflicts

When a mock archive is supplied (tests only), the planner inspects Phase 3A ownership:

| Current state | Meaning |
| --- | --- |
| `VANILLA` | Entry exists and is unmanaged |
| `MANAGED_MOD` | Active owner is another install |
| `EXTERNALLY_MODIFIED` | Live hash ≠ active owner hash |
| `UNKNOWN` | No mock target / no ownership record |

Managed or external targets are `CONFLICT`. External changes are never planned as silent replacements.

## Capability and recommendation

Recognized safely ≠ installable now.

If `archiveRequired` and archive writes are not enabled (`write` / `writeEnabled` false):

- install safety = `UNSUPPORTED`
- recommendation = `UNSUPPORTED`
- reason: “Native GTA archive writing is not enabled in this build.”

This is **not** `BLOCKED` (security) and **not** `SAFE_TO_INSTALL`.

## archiveRequired routing

Vehicle/archive assets never enter the generic copy path.

- Smart Install marks `.yft` / `.ytd` as `skip` with `archiveRequired: true`
- `commit` refuses the whole preview when `archiveRequired` is true
- The legacy installer strips those files from copy lists and rejects vehicle-only packs

No fallback to the Duty root, `mods\`, or other folders.

## Preview

The Smart Install preview shows type, slot, assets, metadata, and either a dry-run archive plan or `ARCHIVE TARGET UNKNOWN` / add-on “recognized but not enabled” copy. The install button is disabled.

Prospective `archiveOperations` exist on the preview only. No committed manifest is written.

## Current unsupported state

### Supported today

- Plugin / callout / filesystem Smart Install V2
- Vehicle recognition, analysis, and dry-run planning
- OPEN RPF7 test-archive reads

### Not yet supported

- Encrypted Enhanced RPF modification
- Real replacement-vehicle archive install
- Automatic EUP / weapon / audio archive installation
- OpenIV, OpenRPF, or any unlicensed overlay

Phase 3D researched a safer manager-owned DLC + overlay model. No licence-clear Enhanced overlay is available to ship. See `docs/enhanced-mod-layer-evaluation.md`.

`ENABLE_NATIVE_ARCHIVE_WRITES` remains `false`. Install strategy selection is dry-run only (`CUSTOM_DLC_LAYER` / `RUNTIME_OVERRIDE` / `NATIVE_ARCHIVE` / `UNSUPPORTED`).
