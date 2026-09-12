# Personal intelligence (V6)

V6 is a polish and local-intelligence layer on top of Smart Install, crash analysis, profiles, and snapshots. It is for personal use. There is no marketplace, accounts, payments, downloads, or telemetry.

Launch, Online, encrypted RPF writes, and Smart Install transactions are unchanged.

## Local knowledge

User overrides live in `userData/data/mod-knowledge/userKnowledge.json`. Built-in `src/data/modKnowledge.json` is never modified.

Field priority is deterministic:

`USER_OVERRIDE` → `LOCAL_VERIFIED_DATA` → `BUILT_IN` → `README_EVIDENCE` → `UNKNOWN`

A user override is always labeled as user-provided. It is not treated as verified global truth.

Editable fields: display name, aliases, author, category, version override, homepage, dependency notes, compatibility notes, personal notes, known-good version, preferred config policy.

## Known-good *mod* version

Separate from a known-good *profile*.

Example: Stop The Ped installed 1.9.0, known-good 1.8.5.

**Restore Known-Good Version** uses the V5 transactional payload restore. If the package is gone, restore is refused. Nothing is invented.

## Update risk

Shown when a dropped package is an update. Never auto-updates.

Risk is `LOW` / `MEDIUM` / `HIGH` / `UNKNOWN`. Version numbers alone never decide risk.

- HIGH: parked framework required, compatibility warning, ownership/protected-file conflict, crash-after-update history
- MEDIUM: unknown compatibility, dependency changes, config schema changes
- LOW: same dependencies, configs preserved, no protected files, compatibility same/verified
- UNKNOWN: not enough local evidence

HIGH-risk installs take a safety snapshot by default. The user can turn that off.

## Mod health

One status per managed mod: `HEALTHY` / `WARNING` / `BROKEN` / `DISABLED` / `UNKNOWN`.

Every non-healthy state includes reasons. Crash numbers are correlation, not proof. Cards can show `Sessions: 8 clean · 2 failed` and which profiles use the mod.

User-facing language uses **Disabled**. Technical `PARKED` stays in developer details.

## Duty health

Overall Duty status is `HEALTHY` / `WARNING` / `BROKEN` — no fake percentage.

Dashboard alerts are priority-sorted:

1. launch-blocking
2. broken mod
3. missing required dependency
4. profile drift
5. stale crash analysis
6. unknown compatibility
7. informational

Mod Manager health is separate (`Check Mod Manager`).

## Dependencies

A simple tree and inverse list. Before disable/remove, required dependents are shown and confirmation is required. Unused libraries can be listed as “possibly unused” and are never auto-removed.

## Smart Install readiness

Preview-before-install stays optional. It defaults ON only when local metrics show:

- at least 10 successful installs
- 0 rollback failures
- low analysis-error rate

Otherwise the previous default stays. Hands-off install is never removed.

Local presets: Safe Plugin Install, Testing Install. They only change snapshot/config/drift/launch-after behavior. No remote lists.

## Storage and backup

Storage & Recovery shows payload, backup, snapshot, session, and staging size.

Cleanup may remove old unpinned automatic snapshots, abandoned staging, and stale temp files. It never deletes pinned/known-good snapshots, active payloads, known-good rollback payloads, or pending crash-action state without an explicit confirmed plan that still excludes those IDs.

**Export Manager Backup** copies manager-owned metadata (profiles, snapshot metadata/config blobs, knowledge, manifests, history, settings). It does not copy the GTA tree.

**Import Manager Backup** validates schema and shows a plan. It does not blindly write Duty.

Diagnostic reports redact usernames, home paths, and obvious secrets.

## Troubleshooting

**Troubleshoot Duty** runs existing checks and suggests one next action. It never applies changes.

If crash analysis is UNKNOWN:

1. switch to known-good profile
2. retest
3. re-enable recent changes one at a time

## Limitations

- No automatic mod downloads
- No encrypted Enhanced archive writes
- Vehicle/EUP/weapon archive packs stay recognized, not auto-installed
- Knowledge is personal and local
- Cleanup never guesses which payload you still need for a missing version

See `docs/current-capabilities.md` for the supported / recognized / unsupported split.
