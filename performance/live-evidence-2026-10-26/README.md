# Live staging evidence loading

Measured 2026-10-26 against https://www.jonathanmellon.com/echo_viewer_staging/ and the real data host, with direct browser requests, no localhost proxy, desktop Chromium, and fresh contexts. Edge: `category-academic-achievement__category-cognitive-ability`, 93 findings. The deployed loader already contained the shared concept-label catalog fix.

Both comparison arms intercept only the evidence adapter module, using either the committed baseline source or the local candidate. Relative module imports retain the deployed release version, so profiling instruments the application's actual shared instances. Neither arm deploys changes. Browser routing can affect caching; these are matched experimental measurements rather than an estimate for every user's connection.

| Measurement | Baseline, three runs | Parallel loading, three runs |
|---|---|---|
| Cold evidence opening | 1873 / 2885 / 2353 ms | 1900 / 1454 / 1902 ms |
| Median cold opening | 2353 ms | 1900 ms |
| Endpoint label lookup | 311 / 607 / 546 ms | 0.3 / 0.3 / 0.1 ms |
| Median warm reopening | 86 ms | 82 ms |
| Completed requests during evidence workflow | 12 | 9 |

The candidate starts the shared search catalog alongside evidence initialization, rather than after the findings query. It also downloads the existing build metadata and canonical findings Parquet during WASM startup, checks manifest byte counts and SHA-256, and registers verified buffers in DuckDB. This replaces serial remote Parquet probes with direct GETs. The findings prefetch is capped at 8 MiB; larger files, missing integrity declarations, and failed verification retain the original remote SQL path. Downloaded content is unchanged, not reduced. Map coordinates and variable lookups are fetched only when map prewarming is requested.

All candidate runs loaded 93 raw findings and 126 endpoint labels, displayed 10 first-page finding actions, and passed Next/Previous checks with no page errors. Separate browser tests compare prefetched findings against a direct canonical query and repeat with a deliberately incorrect expected digest to verify rejection and remote fallback. Both snapshot retrieval tests and `npm test` pass.

Network variability remains material. An earlier intermediate experiment, before parallel catalog loading, saw approximately 18 seconds for WASM and 15.5 seconds for the catalog in one cold context. Those transfers were sequential. This change overlaps them but does not eliminate their bytes or guarantee instant cold loading. The three-run sample covers one edge on one machine.

Reproduce with `scripts/profile_load_evidence.mjs`, setting `PROFILE_URL`, `PROFILE_EDGE_ID`, `PROFILE_RUNS=3`, `PROFILE_OUTPUT`, and `PROFILE_SOURCE_OVERRIDE` to the desired adapter source. Add `PROFILE_VERIFY_PAGINATION=1` for navigation checks. Raw reports are `before.json` and `after.json`; CPU profiles remain in `/private/tmp/echo-live-evidence-matched-before` and `/private/tmp/echo-live-evidence-parallel`.
