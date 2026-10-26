# Sparse-edge filter profile — 2026-10-26

Run from the repository root:

```sh
PROFILE_OUTPUT=performance/sparse-edges-2026-10-26 npm run profile:sparse-edges:new-data
```

The command prepares the new-data site, starts an isolated local server, and profiles Chromium. `PROFILE_RUNS` defaults to 3 fresh browser contexts; `PROFILE_DEVICE=mobile` applies 4× CPU throttling. `PROFILE_PORT`, `PROFILE_SITE_DIR`, and `PROFILE_URL` override the server setup. Use a distinct `PROFILE_OUTPUT` for each run to preserve prior artifacts.

Coverage: default disabled state; cold enable at 2 papers; warm threshold changes to 3, 5, and 2; disable; warm re-enable. Measurements wait for all required evidence and the DAG render, then record wall time, longest/total long tasks, resource requests, and visible-edge/evidence counts. Evidence and rendered-edge checks run outside each timed action. CPU profiles cover the interaction sequence. Data requests use a Playwright proxy for localhost CORS, so network timings include proxy overhead; cross-origin resource sizes can be unavailable. These are measurements, without performance budget gates yet.

## Observed failure

The desktop run used snapshot `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b` and publication `c221423a-9470-4c82-8a3d-8bcf4a01ef7c`: 111 groups, 97,818 variable memberships, and 2,818 baseline edges.

Cold enable failed after **1,615.6 ms**, with a **71 ms** longest main-thread task. The filter requested **66,081** raw evidence records through `loadRawLinksByIds`; DuckDB raised `RuntimeError: memory access out of bounds`. No evidence was loaded and visible edges fell to zero. This reproduced on repeated attempts. Warm threshold/toggle timings were not reached and must not be interpreted as passing.

The benchmark exits nonzero on this failure. `summary.json` records the failed action and evidence counts; `failure.cpuprofile` and `failure.png` preserve the CPU trace and visible state. The product failure remains unresolved by this profiling change.

## Follow-up fix

The bounded-query fix now passes the complete new-data profile. See [verification results](../sparse-edges-fixed-2026-10-26/README.md), including desktop, 4× CPU, and injected failure recovery checks.
