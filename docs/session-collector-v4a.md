# Session & crash collector (V4A)

V4A records evidence about each Play LSPDFR launch. It does **not** diagnose root cause. Diagnosis is V4B; see `docs/crash-analyzer-v4b.md`.

Launch repair, BattlEye, overlay suppression, RPH elevation, and process cleanup are unchanged. The collector observes them.

## Schema

Each session is `userData/sessions/<sessionId>/session.json`:

```json
{
  "schemaVersion": 1,
  "sessionId": "uuid",
  "startedAt": "...",
  "endedAt": "...",
  "state": "COMPLETED",
  "result": "CLEAN_EXIT",
  "confidence": "MEDIUM",
  "environment": { "gtaVersion": "...", "lspdfrVersion": "...", "rphVersion": "..." },
  "mods": [{ "installId": "...", "canonicalModId": null, "enabled": true }],
  "recentChanges": [],
  "processes": { "atLaunch": [], "rph": {}, "gta": {} },
  "logs": [],
  "timeline": [],
  "evidence": []
}
```

Session files never go in GTA folders. No telemetry.

## States

`CREATED` → `PREFLIGHT` → `LAUNCHING` → `RPH_STARTED` → `GAME_STARTED` → `LSPDFR_LOADING` → `ACTIVE` → `EXITING` / terminal.

Terminal: `COMPLETED`, `CRASHED`, `UNKNOWN`.

`INCOMPLETE` means the manager closed while the session was still open. Recovery does **not** invent a crash.

## Results

| Result | When |
| --- | --- |
| `CLEAN_EXIT` | Shutdown log + both processes exited, or active session ended with no crash markers (MEDIUM) |
| `LAUNCH_FAILED` | RPH/GTA never reached launch, or launcher threw |
| `RPH_CRASH` | RPH fatal log or RPH exited first while GTA still ran |
| `GAME_CRASH` | Game-crash log line or Windows Application Error for GTA5_Enhanced |
| `LSPDFR_CRASH` | Clear LSPDFR/plugin failure in logs |
| `TERMINATED` | Manager requested stop (new launch / leftover cleanup of this session) |
| `UNKNOWN` | Anything else |

Confidence: `HIGH` / `MEDIUM` / `LOW` / `UNKNOWN`. Insufficient evidence stays `UNKNOWN`.

V4A never names a mod as the cause.

## Monitoring

A process adapter polls only known images (RPH, GTA Enhanced, NVIDIA overlay, Cortex, Discord, RTSS, Afterburner) about every 4 seconds. Tests inject a fake adapter. Exit codes are recorded when the adapter provides them.

## Logs

Duty-only: `RagePluginHook.log`, `plugins/LSPDFR` logs, `asiload.log`. Metadata: path, size, mtime, SHA-256 when the file is ≤ 8 MiB. Crash/failed sessions copy the last 400 lines into `sessions/<id>/logs/` and hash the excerpt.

## Retention

Index: `userData/sessions/index.json`. Keep 80 sessions. Queries: recent, successful, failed, by `installId`.

## Recovery

On manager start, incomplete sessions are reconciled: if RPH/GTA still run, monitoring resumes; if they are gone, the session is finalized conservatively.
