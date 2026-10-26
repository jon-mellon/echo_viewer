# Faster sparse-edge filtering on staging — 2026-10-26

The filter loads only raw finding IDs, paper IDs, and claim status in one column-projected scan. This avoids the 33 full-record queries previously needed for 66,081 findings. Compact support records live in a separate snapshot-scoped cache so the evidence inspector still fetches full records on demand. Legacy snapshots without claim status retain the existing assumption that those records support edges.

Threshold and toggle updates recompute the filtered DAG without rebuilding memberships, candidates, the variable map, or project persistence. Existing node positions and routes are reused when the visible groups and edges permit it; the existing full-render fallback handles changes requiring new geometry. Missing or failed support loads continue to preserve the visible graph and disable the filter. Results from a superseded snapshot are discarded.

## Real-data measurements

Same snapshot as the bounded-query baseline: `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`; publication `c221423a-9470-4c82-8a3d-8bcf4a01ef7c`. There are 111 groups, 97,818 memberships, and 2,818 baseline edges. Desktop numbers are medians of three fresh-context runs. The 4× CPU column is one run, simulating slower CPU rather than a physical phone.

| Action | Before desktop (ms) | After desktop (ms) | Speedup | After 4× CPU (ms) |
| --- | ---: | ---: | ---: | ---: |
| enable sparse filter (cold evidence, minimum 2) | 5696.1 | 1709.9 | 3.33× | 2654.1 |
| change minimum papers to 3 (warm evidence) | 524.8 | 86.7 | 6.05× | 267.6 |
| change minimum papers to 5 (warm evidence) | 358.1 | 73.6 | 4.87× | 226 |
| change minimum papers to 2 (warm evidence) | 691 | 122.4 | 5.65× | 410.6 |
| disable sparse filter | 1425.6 | 154.7 | 9.22× | 529.6 |
| enable sparse filter (warm evidence, minimum 2) | 780.1 | 123.8 | 6.3× | 362.6 |

All six actions passed in every run. Thresholds of 2/3/5 retain exactly 1,945/1,476/1,012 edges. Disabling restores 2,818 edges. Warm interactions make zero network requests and load zero full evidence records. Full-record detail loading remains available on demand.

`check/summary.json` additionally verifies every filtered edge against independently fetched full evidence, checks that removed edges are absent from the rendered map, opens an evidence inspector and confirms full details load, and injects both rejected and incomplete support responses. Both injected failures preserve 2,818 edges during loading and recovery, then return the filter to disabled. The expected injected errors do not count as unexpected browser errors.

## Reproduce

```sh
PROFILE_OUTPUT=performance/sparse-edges-fast-2026-10-26/desktop npm run profile:sparse-edges:new-data
PROFILE_RUNS=1 PROFILE_DEVICE=mobile PROFILE_OUTPUT=performance/sparse-edges-fast-2026-10-26/mobile npm run profile:sparse-edges:new-data
PROFILE_RUNS=1 PROFILE_VERIFY_RAW=1 PROFILE_TEST_FAILURE=1 PROFILE_OUTPUT=performance/sparse-edges-fast-2026-10-26/check npm run profile:sparse-edges:new-data
```

Timing includes Playwright action overhead, real data requests through the localhost CORS proxy, and completion of the graph render. Correctness checks and the optional full-evidence reference query run outside each timed action. Each run saves a summary and CPU trace. Measurements are diagnostic rather than CI performance budget gates.

Validation: 67 focused tests plus type, DOM safety, and feature boundary checks passed. Added regression tests cover compact/full support equivalence, mixed-cache evidence, and view updates that avoid membership and map rebuilds.
