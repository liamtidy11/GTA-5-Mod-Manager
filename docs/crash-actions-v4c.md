# Crash actions & retest (V4C)

V4C turns a V4B recommendation into a **user-confirmed, reversible test**. It does not remediate crashes automatically.

The user must always know what will change, why, how to undo it, and what the retest did or did not prove.

Launch repair, BattlEye, overlay suppression, RPH elevation, and process cleanup are unchanged. V4C calls existing Smart Install enable/disable, repair, and analyze/commit paths. It never uninstalls a mod as a crash test.

## Action types

| Type | When it is offered |
| --- | --- |
| `DISABLE_MOD_AND_RETEST` | Analysis names a managed, currently enabled mod |
| `ROLLBACK_MOD_AND_RETEST` | Analysis has a version change-point **and** a previous payload/source is available |
| `REPAIR_MOD_AND_RETEST` | Managed files are missing and a stored copy exists (`smartRepair`) |
| `CLOSE_OVERLAY_AND_RETEST` | Overlay / graphics-hook suspect. Uses the existing temporary NVIDIA close on Play LSPDFR |
| `RE_ENABLE_MOD` | Required dependency is parked. Stronger confirmation |
| `REPAIR_EXISTING_DEPENDENCY` | Required dependency is already managed and repairable |
| `OPEN_DEPENDENCY_DETAILS` | Required dependency is missing. No download |
| `MINIMAL_RETEST` | Recently changed mods are managed; they can be disabled while the core stack stays |
| `RESTORE_PREVIOUS_STATE` | After any applied test |
| `KEEP_DISABLED` | After a no-crash retest; leaves current state |
| `NO_SAFE_ACTION` | Nothing the manager can safely do |

Do not invent actions the manager cannot perform. Version rollback is **not** offered unless the previous package can go through the existing Smart Install downgrade (`analyze` + `commit`).

## Planning

`planForSession` is read-only for Duty files. It writes `userData/crash-actions/<actionId>.json` in `PLANNED` state.

A plan includes `changes[]`, `reversible`, expected installId/version/enabled, and a preview for rollback.

The user picks **one** test at a time. Multiple suspects are not applied together.

## Confirmation

No Duty change happens until the user confirms. Example:

> Stop The Ped will be disabled temporarily. No files will be deleted. Your current state can be restored after the test.

Parked-dependency re-enable adds: re-enabling may reintroduce a known local stability issue.

## Snapshot

Before apply, V4C stores:

- enabled/disabled state
- version
- config policy
- managed file list
- environment fingerprint
- originating sessionId and analysis fingerprint

Rollback also copies the current payload/manifest into the action snapshot so “restore 1.8” can reverse a successful downgrade.

## Stale analysis

If analysis is `STALE`, the environment versions changed, the target mod is gone, or its version/enabled state no longer matches:

- action buttons are disabled
- apply throws

Copy:

> This crash analysis is out of date because the Duty setup changed. Re-analyze before applying a test.

## Apply and restore

| Action | Existing path | Restore |
| --- | --- | --- |
| Disable | `smartInstall.setEnabled(false)` | `setEnabled(true)` from snapshot |
| Re-enable | `setEnabled(true)` | `setEnabled(false)` |
| Repair | `smartInstall.repair` / `smartRepair` | no file delete; user can re-disable |
| Rollback | `smartInstall.analyze` + `commit` of the previous source | restore snapshotted payload + manifest |
| Overlay | existing `suppressOverlaysDuringHook` on launch | no global driver change |

If apply throws, the action is `FAILED` and V4C attempts to restore the snapshot. Existing Smart Install transactions still roll back their own copies.

Launch is **never** started by apply. The UI offers Play LSPDFR.

## Retest link

The next Play LSPDFR after an `APPLIED` action records on the session:

```json
{
  "retestOfSessionId": "...",
  "crashActionId": "..."
}
```

## Retest outcomes

Observable only. Not causation.

| Outcome | Rule |
| --- | --- |
| `CRASH_REPRODUCED` | Retest result is `GAME_CRASH`, `RPH_CRASH`, or `LSPDFR_CRASH` |
| `LAUNCH_FAILED` | Retest result is `LAUNCH_FAILED` |
| `NO_CRASH_OBSERVED` | `CLEAN_EXIT` **and** duration meets a conservative threshold |
| `UNKNOWN` | Anything else, including a 5–60s “clean” run |

Duration: if the original crash was under 2 minutes, the retest must last at least `max(3× original, 90s)`. Otherwise `max(original + 5 minutes, 10 minutes)`. Runs under 60 seconds are never a successful retest.

Phrasing:

- “Crash was not observed after disabling Stop The Ped.”
- Not: “Stop The Ped definitely caused the crash.”

## Evidence handoff (V4B)

Stored on the action as `retest.evidenceType`:

- `RETEST_NO_CRASH`
- `RETEST_CRASH_REPRODUCED`

Later analysis may consume these as modest score adjustments. They never prove a cause by themselves.

## Restart recovery

Pending actions live in `userData/crash-actions/`. If the manager restarts after apply and before launch:

- Continue retest
- Restore previous state

The pre-test snapshot is not discarded.

## Audit

Local Smart Audit only:

`CRASH_ACTION_PLANNED`, `CRASH_ACTION_APPLIED`, `CRASH_RETEST_LAUNCHED`, `CRASH_RETEST_COMPLETED`, `CRASH_ACTION_RESTORED`, `CRASH_ACTION_FAILED`.

No telemetry.

## Limitations

- No previous-version payload means no rollback button.
- Missing dependencies are not downloaded.
- Overlay close is session-scoped, same as today’s launcher.
- `MINIMAL_RETEST` only disables managed recent changes. Full profiles are V5.
- Quarantine is not built.

## V5 handoff

Profiles/snapshots can replace the compact action snapshot. Quarantine can wait until several retests agree. V4C must stay opt-in and reversible.
