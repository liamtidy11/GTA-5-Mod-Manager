# Current capabilities

Personal GTA V Enhanced / LSPDFR manager. Duty (sandbox) and Online (official Steam) stay separate. Nothing here mods GTA Online.

## Fully supported

- LSPDFR + Rage Plugin Hook setup in the Duty folder only
- Plugin / script / ASI filesystem installs via Smart Install
- Transactional commit, enable, disable, uninstall, repair, and rollback
- Manifests, payload store, backups, and local audit
- Version detection and update/downgrade relation (no auto-update)
- Mod recognition from local knowledge (not invented identities)
- Dependency resolution and install recommendations
- Compatibility analysis (unknown is not treated as blocked)
- Session collection for each Play LSPDFR launch
- Crash analysis (likely causes, not proven causes)
- Reversible crash retest actions (disable, rollback, repair, overlay)
- Profiles (how you want Duty configured)
- Snapshots (how Duty was configured)
- Known-good profile restore and known-good *mod version* restore when a payload exists
- Profile drift detection (no silent rewrite)
- Personal knowledge overrides
- Unified mod health and Duty health reasons
- Generic runtime verification for every managed plugin (manifest DLL ownership, built-in or local rules, then generic load/service/callout signals). Unknown stays yellow until explicit success or failure.
- Duty-wide log scan: RPH, LSPDFR, ASI, ScriptHook, rotated `Logs\`, and per-plugin `.log` files inside the Duty folder only. Folder plugin/ASI packs use the same in-game proof as Smart Install.
- Diagnostic report export (redacted)
- Manager metadata backup export/import
- Safe storage cleanup of unused manager files
- Browse Mods workshop: local catalog, official source links, import into Smart Install, optional Downloads inbox

## Recognized but not automatically installable

- Encrypted GTA V Enhanced vehicle replacements (`.yft` / `.ytd` in official archives)
- Some EUP / clothing archive mods
- Weapon and audio archive replacements
- Other OpenIV-style archive edits

The manager can identify assets, slots, and metadata, and it will say so. Automatic installation is unavailable for encrypted Enhanced archives. This is not an OpenIV replacement.

## Intentionally unsupported

- Online / official Steam folder modding
- Automatic encrypted RPF modification
- OpenIV automation
- Cloud profiles, public sharing, or a hosted mod marketplace (Browse Mods is local discovery + official links only)
- Automatic community compatibility or telemetry
- Payments, accounts, or licensing
- Killing GTA / RPH when the manager restarts
