# Crash analyzer (V4B)

V4B ranks **likely causes** for a failed or unknown LSPDFR session. It does **not** prove a cause, disable mods, roll back versions, or relaunch.

False confidence is worse than an incomplete diagnosis. Prefer “I don’t know yet” over blaming the wrong mod.

Launch repair, BattlEye, overlay suppression, RPH elevation, and process cleanup are unchanged. Analysis never writes into Duty or Online folders except for `userData/sessions/<sessionId>/analysis.json`.

V4C will execute recommended tests. This milestone only suggests them.

## Input

`sessionId` only. No re-launch and no Duty directory rescan.

Loaded from stored session evidence plus other session records:

- target session, result, timeline, duration
- environment snapshot (GTA / RPH / LSPDFR versions)
- enabled-mod snapshot
- recent Smart Audit changes
- copied log tails (session folder only)
- overlay / known-process snapshot
- previous clean and failed sessions

Duty log paths recorded on the session are **not** re-opened.

## Output

```json
{
  "sessionId": "...",
  "result": "RPH_CRASH",
  "analysisConfidence": "HIGH",
  "summary": "...",
  "suspects": [],
  "systemFindings": [],
  "alternatives": [],
  "recommendedTests": []
}
```

`analysisConfidence`: `HIGH` | `MEDIUM` | `LOW` | `UNKNOWN`.

## Suspect types

`MOD`, `DEPENDENCY`, `OVERLAY`, `CORE_COMPONENT`, `GRAPHICS_HOOK`, `CONFIGURATION`, `RECENT_CHANGE`, `UNKNOWN`.

A displayed suspect includes `score`, `confidence`, `reasons[]`, and `counterEvidence[]`.

Never say “Mod X caused the crash” unless evidence is genuinely definitive. Prefer “Mod X is the strongest current suspect.”

## Scoring

Deterministic weighted scores. Bands:

| Band | Score |
| --- | --- |
| HIGH | ≥ 75 |
| MEDIUM | 50–74 |
| LOW | 25–49 |
| WEAK | < 25 |

Only suspects at 25+ are shown (unknown named DLLs are always shown). Being enabled is never enough for a high-confidence suspect.

### Weights

| Evidence | Weight |
| --- | --- |
| Exact plugin / DLL named in an exception | +75 |
| Fatal log names a plugin | +70 |
| Loader failure names a dependency | +70 |
| Last loaded component before fatal | +22 |
| Installed / updated immediately before the session | +18 |
| Newly enabled vs last clean session | +14 |
| Repeated failed sessions share the mod; clean sessions do not | +28 (reduced for tiny samples) |
| Version change-point / version split in history | +32 |
| Compatibility `NOT_RECOMMENDED` / warning | +10 |
| Required dependency missing | +42 |
| Required dependency disabled | +40 |
| Optional dependency missing | +6 |
| Short duration after a named plugin | +8 |
| Enabled only | +5 |
| Overlay present this session | +8 |
| Overlay on in failed history, off in clean history | +32 / +52 when the local sample is stronger |
| GTA version change with unchanged mods | +40 |
| RPH or LSPDFR version change | +36 |
| Named core component | +55 |

### Counter-evidence (subtracted)

| Evidence | Weight |
| --- | --- |
| Same mod/version in many clean sessions | −16 |
| Crash predates the install | −50 |
| Fatal log names another component | −22 |
| Tiny sample, no named plugin | −8 |

Duration is supporting evidence only. Optional missing dependencies must not dominate a named plugin.

## Confidence

- **HIGH** — one high-scoring suspect plus corroboration (named module, repeated failures, or a version change-point).
- **MEDIUM** — a high suspect without corroboration, or a medium suspect / several moderate signals.
- **LOW** — weak correlations only.
- **UNKNOWN** — nothing ranks, or logs and history are insufficient.

Sample size matters. One failed session is limited evidence unless a log names a module.

## Session comparison

`sessionComparator` finds the last known-good session and the first failed session, then diffs:

- newly installed / enabled mods
- version changes
- overlay presence
- GTA / RPH / LSPDFR versions

Phrase: “Updated immediately before failures began,” not “The update caused the crash.”

## Log patterns

Declarative patterns in `logPatternAnalyzer.js`:

- plugin exception
- DLL load failure
- missing dependency
- timeout
- fatal RPH
- LSPDFR initialization failure
- graphics / D3D / NvCamera / device removed
- access violation
- file not found
- invalid config

A named DLL is mapped to an installed mod, plugin inventory name, or canonical id when possible. Otherwise the UI shows `Unknown plugin/component: Example.dll` and does not invent an identity.

Graphics-hook matches are classified separately from plugin DLL failures.

## Overlay and local history

A single overlay sighting is weak. Local history is stronger than a generic “overlays can conflict” warning:

> NVIDIA Overlay was present in 5 failed sessions and absent in 8 clean sessions.

## Dependencies and compatibility

Phase 2D dependency rows on the session (or injected test data) contribute:

- required missing / disabled / too old — meaningful
- optional missing — weak

A session that launched with `NOT_RECOMMENDED` mods keeps that as medium/weak evidence, not proof.

## Core components

RAGE Plugin Hook, LSPDFR, GTA build, DirectStorageFix, HeapAdjuster, Packfile Limit Adjuster, and the ASI loader are only surfaced when logs or a version change-point justify it.

## Recommended tests

Suggestions only (`execute: false`):

- Disable the top mod suspect and relaunch
- Restore the previous version
- Close an overlay and retest
- Repair a required dependency
- Launch with recently changed mods disabled

V4B never runs them.

## Persistence and invalidation

`userData/sessions/<sessionId>/analysis.json` stores `analyzerVersion`, `rulesVersion`, `createdAt`, evidence fingerprint, and scores.

The analysis is marked `STALE` when:

- copied log / session hashes change
- enabled-mod identity or versions change
- `analyzerVersion` or `rulesVersion` no longer match

Re-analysis overwrites the file. No telemetry and no external upload.

## UI

- **Analyze Crash** is enabled for `GAME_CRASH`, `RPH_CRASH`, `LSPDFR_CRASH`, `LAUNCH_FAILED`, and `UNKNOWN`. Clean sessions hide it unless developer mode (`localStorage tactix.dev=1`).
- Results show the strongest suspect, why, counter-evidence, one recommended test, and alternatives.
- If nothing ranks: **No clear cause identified**.
- The dashboard last-session card shows a compact likely-suspect line only after analysis exists.
- Technical details (scores, weights, samples, matched patterns) are collapsed.

## Limitations

- Correlation is not causation.
- Tiny histories overstate easily; confidence stays conservative.
- Mapping a DLL to a mod can fail when names differ; unknown is preferred.
- Copied tails are bounded (400 lines). Older log context may be missing.
- V4A classification can be `UNKNOWN`; the analyzer will not invent certainty on top of that.

## V4C / retest evidence

V4C may execute recommended tests. V4B remains analysis-only unless a later analyze pass is given stored retest evidence:

- `RETEST_NO_CRASH` — modest extra suspicion after a conservative no-crash retest
- `RETEST_CRASH_REPRODUCED` — modest counter-evidence if the crash persisted

Neither is treated as proof. See `docs/crash-actions-v4c.md`.

## Privacy

Analysis stays in local `userData`. No crash upload, no telemetry, no remote scoring.
