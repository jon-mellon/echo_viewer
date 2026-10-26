# Evidence loading options without rebuilding data

2026-10-26. All options use the existing immutable files. Experimental overrides live only in `scripts/profile_evidence_options.mjs`; production application modules were not changed by these experiments.

Three fresh Chromium contexts per option, run sequentially with no CPU or network throttling. Same new-data snapshot, 97,818 schema members, 111 groups, and edge `category-academic-achievement__category-cognitive-ability` (93 raw findings). First pages show five findings per direction and require 18 concept labels in the original order. All search catalogs started idle. Each run checks Next/Previous and compares every loaded label against the original Parquet query outside the timed measurements. All 15 runs passed with no page errors.

| Option | Median cold evidence opening | Median first-page label lookup | First-page label requests | First-page label bytes | Median Next |
|---|---:|---:|---:|---:|---:|
| Current paginated loader | 3,954 ms | 2,147 ms | 51 | 1.06 MiB | 731 ms |
| Greedy shard-local first-page ordering | 2,922 ms | 1,021 ms | 42 | 0.87 MiB | 583 ms |
| Fetch whole needed shards, query in memory | **1,951 ms** | **215 ms** | 17 | 1.06 MiB | 199 ms |
| Existing snapshot search catalog | 2,405 ms | 257 ms | 1 catalog request | 7.21 MiB | 148 ms |
| Existing canonical variable Parquet | 2,489 ms | 674 ms | 3 | 17.65 MiB | 209 ms |

The request and byte columns cover labels for the first page only, excluding shared manifest/engine/raw-finding startup and pagination. The catalog additionally loads two small worker/module files. Raw report request arrays include the entire cold/warm/Next/Previous workflow but exclude the untimed correctness queries. `comparison.json` has numeric summaries; each option's JSON has all runs, requests, timings, and verification counts. CPU traces are under `/private/tmp/echo-evidence-options-{option}`. Baseline/locality traces include the untimed correctness query; later option traces stop before that query.

## Interpretation

**Fetch the existing small shards directly** is the strongest measured cold-load option: roughly half the total opening time and 90% less label-query time than the fresh baseline, with identical finding order and label bytes. Fetching up to six shards concurrently and registering their buffers with DuckDB replaces per-file remote metadata probes with one GET per file. The measured shards are roughly 62–68 KiB each. This option retains buffers for reuse; production adoption should set a bounded cache and fall back cleanly on failures.

**Shard-local ordering** reduces the first page from 17 shards to 14. The greedy selection chooses the next finding with the fewest additional endpoint shards, sharing the chosen shard set across directions. It preserves all IDs but changes finding order. It offers less benefit than direct fetches and is unnecessary to obtain the strongest speedup. The first-page label set changes (15 variables rather than 18), so the full-shard/catalog/canonical comparisons are cleaner same-record comparisons.

**Reuse the search catalog** is attractive when search has already loaded it: the measured subsequent page's label lookup is approximately zero. The cold catalog option explicitly waits for the existing worker-based loader after evidence opening, including parsing/indexing; it does not assume a warm catalog. However, the 7.21 MiB catalog is served by the local preview in this harness. Its speed is optimistic for a slow production connection. All 24 labels checked across first/next pages exactly matched canonical Parquet results for this edge. Other edges/unknown snapshots would still need coverage checks and a Parquet fallback.

**Canonical variable Parquet** reduces requests dramatically but downloads 17.65 MiB. It is slower than direct small-shard fetches here and incurs much more bandwidth; fewer requests alone is not the objective.

The shared cold-load floor still includes DuckDB initialization, shard lookup, and raw findings. The raw-finding GET in these runs returns 7,087,503 bytes. None of these label experiments changes that path.

## Method and limits

The local preview uses `dist/new-data-site`. Remote data requests are proxied through Playwright to avoid localhost CORS; timings include that proxy. Browser contexts are fresh but the browser process and upstream/server caches are shared. These are three-run local measurements on one edge, without bandwidth throttling or a representative sweep of edge sizes. Network variation is visible in the raw timings. Catalog files are local; Parquet files are remote. Page CPU profiles omit worker CPU. Other work was in progress in the shared working tree.

The request log records HTTP methods and response bodies. In these runs the original three requests per variable shard are **HEAD, GET, HEAD**, with a full-file GET, not three range-data reads. This corrects the earlier working hypothesis about range requests. Thus the direct-fetch option removes round trips without increasing measured label transfer bytes. Response-body counts are useful per-label-file measurements, not an exact accounting of all browser network traffic (e.g. the engine WASM body is unavailable to this instrumentation).

Reproduce any option:

```sh
PROFILE_EVIDENCE_OPTION=full-shards PROFILE_RUNS=3 PROFILE_VERIFY_PAGINATION=1 PROFILE_OUTPUT=/private/tmp/echo-evidence-options-full-shards PROFILE_PORT=8782 node scripts/profile_load_evidence.mjs
```

Options: `baseline`, `locality`, `full-shards`, `catalog`, `canonical`. Prepare the preview with `node scripts/prepare_new_data_site.mjs` if missing. The profile uses benchmark-only overrides and does not publish or rewrite physical data. The inspector's 13 focused unit tests and JavaScript syntax checks also pass.
