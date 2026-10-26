# Load evidence: new-data desktop baseline

Run on 2026-10-26 with three fresh Chromium contexts, 1365 × 900 viewport, no CPU or network throttling. Schema: 97,818 members, 111 groups; snapshot `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`.

```sh
node scripts/prepare_new_data_site.mjs
node scripts/profile_load_evidence.mjs
```

The profile waits for schema hydration, selects the first two populated groups as IV/DV, shows the unfiltered graph, and opens the first rendered evidence edge through `inspectDagEdge`, the same inspector path used by graph clicks. This application version loads evidence automatically on edge selection; there is no separate Load evidence button. The endpoint is a visible Exclude finding button, followed by two animation frames. It separately waits for pending metadata to finish, then closes and reopens the same edge. These timings include browser automation overhead, with a roughly 30 ms two-frame floor.

Default output: `/private/tmp/echo-load-evidence`, including CPU profiles and summary.json. Environment overrides: PROFILE_OUTPUT, PROFILE_RUNS, PROFILE_PORT (default 8779), PROFILE_URL, PROFILE_SITE_DIR, and PROFILE_DEVICE=mobile (4× CPU throttling, desktop viewport). The preview must already have been prepared; the benchmark rejects schemas below 90,000 members. An occupied local port fails rather than silently testing another build.

Remote evidence is proxied through Playwright to avoid the data host's localhost CORS restriction. These are local baseline measurements including proxy overhead, not production network guarantees. Each context begins without hydrated raw links or variables; the browser process and remote caches are shared. Other working-tree edits were present during measurement.

| Measurement | Run 1 | Run 2 | Run 3 | Median |
|---|---:|---:|---:|---:|
| Cold selection → visible findings | 11,997 ms | 11,514 ms | 10,027 ms | 11,514 ms |
| Remaining metadata wait | 33 ms | 33 ms | 33 ms | 33 ms |
| Warm reopening → visible findings | 92 ms | 88 ms | 92 ms | 92 ms |
| Cold longest main-thread task | 72 ms | 68 ms | 69 ms | 69 ms |

All three runs selected `category-academic-achievement__category-cognitive-ability`, loaded 93 raw links and 126 variables, and displayed 10 finding actions (the current page). No page errors occurred. This baseline covers one edge, not the distribution across edge sizes.

Each cold run made 344 completed requests, including 333 requests for variable shards. Requests include repeated metadata/range access; this is not 333 distinct shard files. The first main-thread CPU trace attributed about 11.8 seconds to idle time, supporting the conclusion that the delay is dominated by asynchronous retrieval/worker work rather than a long main-thread freeze. Worker CPU is not captured by this page CPU profile. The raw-link query uses canonical causal_link_occurrences.parquet; provenance then queries the variable shards for endpoint labels. These are the next paths to investigate, especially shard request fan-out. The baseline does not isolate each query's contribution.

Raw timings and request URLs/statuses are in desktop.json. CPU traces remain in `/private/tmp/echo-load-evidence/cpu-{0,1,2}.cpuprofile`. No application behavior was changed for this profile.

## Visible-page label loading

The inspector now hydrates concept labels for the current five rows in each direction, rather than every finding on the edge. Next/Previous initiate label hydration for the requested page; cached labels are reused. A page change during an in-flight request is followed by loading the currently requested page. Raw finding records still load for the entire selected edge, preserving direction order, totals, exclusions, and pagination.

Three fresh desktop contexts using the same harness:

| Measurement | Original median | Visible-page median |
|---|---:|---:|
| Cold selection → visible finding actions | 11,514 ms | 3,912 ms |
| Warm reopening | 92 ms | 94 ms |
| Completed requests | 344 | 63 |
| Hydrated concept variables | 126 | 18 |

Cold runs: 3,912 / 3,933 / 3,468 ms. No page errors. Raw results: paged-desktop.json; CPU traces: `/private/tmp/echo-load-evidence-paged/cpu-{0,1,2}.cpuprofile`. Local proxy timings retain the baseline caveats.

An additional run with `PROFILE_VERIFY_PAGINATION=1 PROFILE_RUNS=1` verified Next changes the displayed findings, loads the page labels, and Previous restores the original first finding. Next took 531 ms in that run; raw results: pagination-desktop.json. `npm test` passes, including the focused visible-page hydration coverage.
