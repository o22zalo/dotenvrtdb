Path:CHANGE_LOGS.md
## 2026-04-08 — smoke workflow now verifies fast keepalive stop end-to-end

### Technical changes
- Reworked `.github/workflows/keepalive-stop-smoke.yml` to run the local repository code with `npm ci` + `node cli.js`, instead of installing the published npm package.
- Added a background keepalive process, a deliberate RTDB owner flip, and an assertion window of 20 seconds so the smoke test now validates actual stop latency.
- The smoke job now checks for exit code `130` and stop-related log markers (`Stop requested`, `source=sse|poll`, `Aborting in-flight docker command`).
- Kept cleanup after assertion so the workflow remains deterministic without masking whether keepalive itself stopped quickly.

## 2026-04-08 — runner keepalive remote-stop hardening

### Technical changes
- Refactored `src/commands/runner/stop-listener.js` to use a shared stop state (`requestStop`, `getStopState`, `onStopRequested`, `isStopRequested`) instead of directly forcing the whole stop flow from the listener thread.
- Added exact-value polling fallback via `STOP_VALUE_POLL_INTERVAL_MS` so owner comparison still works when SSE misses events or reconnect is delayed.
- Fixed Firebase SSE handling to apply `path` + `data` payloads before comparing owner value, instead of comparing raw `payload.data` directly.
- Reworked `src/commands/runner/keepalive.js` so `runCycle()` now checks shared stop state before, during, and after each docker operation.
- Added immediate abort of in-flight `docker compose logs` / `docker compose ps` child processes when stop is requested.
- Changed remote cancel behavior to best-effort non-blocking GitHub/Azure requests, while local keepalive exits quickly with explicit stop reason logs.
- Updated `.github/workflows/keepalive-stop-smoke.yml` so cleanup no longer uses `if: always()`; this prevents the smoke workflow from masking cancellation latency caused by GitHub Actions cancellation semantics.

### Verified locally
- `node --check src/commands/runner/stop-listener.js`
- `node --check src/commands/runner/keepalive.js`
- local HTTP/SSE simulation confirmed stop callback fires when owner changes
- fake-docker integration simulation confirmed keepalive exits quickly with code `130` and aborts in-flight docker command
