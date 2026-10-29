# Sparse-edge loading fix — 2026-10-26

Evidence queries now run in batches of at most 2,048 distinct IDs instead of sending the entire 66,081-record request to DuckDB-WASM. The viewer keeps its current map until evidence is complete. Failed or incomplete evidence loads turn the filter off and restore the unfiltered view; they cannot leave a partial or empty graph.

Verified against new-data snapshot `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`, publication `c221423a-9470-4c82-8a3d-8bcf4a01ef7c`: 111 groups, 97,818 memberships, 2,818 baseline edges. All three desktop runs and the single 4× CPU-throttled run passed the full six-action profile, loading 66,081 evidence records without browser errors.

| Action | Desktop median (ms, 3 runs) | 4× CPU (ms, 1 run) |
| --- | ---: | ---: |
| enable sparse filter (cold evidence, minimum 2) | 5696.1 | 8184.6 |
| change minimum papers to 3 (warm evidence) | 524.8 | 1235.0 |
| change minimum papers to 5 (warm evidence) | 358.1 | 929.8 |
| change minimum papers to 2 (warm evidence) | 691.0 | 1518.0 |
| disable sparse filter | 1425.6 | 2411.5 |
| enable sparse filter (warm evidence, minimum 2) | 780.1 | 1577.7 |

Paper thresholds of 2, 3, and 5 retain 1,945, 1,476, and 1,012 edges respectively. Disabling restores all 2,818 edges. The profile independently checks paper support and rendered edges.

The recovery run additionally injects both a rejected load and an incomplete response. In both cases, all 2,818 edges stay visible while loading and after recovery, and the filter returns to disabled. Expected injected errors are logged separately from unexpected browser failures.

```sh
PROFILE_OUTPUT=performance/sparse-edges-fixed-2026-10-26/desktop npm run profile:sparse-edges:new-data
PROFILE_RUNS=1 PROFILE_DEVICE=mobile PROFILE_OUTPUT=performance/sparse-edges-fixed-2026-10-26/mobile npm run profile:sparse-edges:new-data
PROFILE_RUNS=1 PROFILE_TEST_FAILURE=1 PROFILE_OUTPUT=performance/sparse-edges-fixed-2026-10-26/recovery npm run profile:sparse-edges:new-data
```

Each output folder contains `summary.json` and CPU traces. Timings include real remote data through the localhost CORS proxy and graph layout/routing. The mobile run simulates slower CPU rather than a physical phone. The original failure is preserved in `../sparse-edges-2026-10-26/`.

Validation: 56 focused tests plus type, DOM safety, and feature boundary checks passed.
