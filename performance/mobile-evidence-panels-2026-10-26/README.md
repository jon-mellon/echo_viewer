# Mobile source loading without DuckDB

The reported stuck panel is `category-academic-achievement__category-macroeconomic-context`, with two raw findings in snapshot `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`. Previously its sources required the query engine (the uncompressed local WASM asset is 33 MiB), canonical findings Parquet (7,087,503 bytes), and endpoint labels from the search catalog (7,564,095 bytes). Parallel downloads reduced some waits but retained this cold-start dependency.

The new static fast path fetches a pinned compressed index (215,842 bytes, shared across edges) and an immutable bundle for the exact requested finding IDs. This edge's bundle is 713 bytes and contains both complete canonical finding rows and their endpoint labels. Sources do not depend on DuckDB, the evidence manifest, full findings Parquet, or the full search catalog. Unknown snapshots, unmatched/edited finding sets, and failed downloads or integrity checks use the existing evidence adapter.

Bundles are derived from the existing canonical Parquet and published compiled DAG, with labels from the matching immutable search catalog. The generator verifies canonical bytes and SHA-256 against the snapshot manifest and checks every referenced finding and endpoint. All 2,818 distinct published edge finding sets have bundles, totaling 10,961,008 compressed bytes across the site. Browsers request only the selected edge's bundle. Bundle and index bytes are digest-checked, exact finding-set coverage is checked, and snapshot IDs are validated. Concurrent requests share promises; the in-memory cache is bounded to 64 entries. This does not change findings, their direction, or their display order.

## Verification on 2026-10-26

- Chromium mobile UI, 390 × 844, 4× CPU slowdown, 150 ms latency, 200 KiB/s download: pictured edge's two findings and labels appeared in 1,610 ms, with exactly two bundle requests and no DuckDB, Parquet, or search-catalog requests.
- WebKit mobile UI: 136 ms on the local preview without network/CPU throttling, also exactly two data requests and no query engine. WebKit is a Safari-engine check, not a physical iPhone measurement.
- Both browsers passed a deliberately corrupted-bundle test: the original snapshot query supplied the findings and labels successfully.
- Focused real-data profiler, 4× CPU slowdown, desktop viewport, local assets and unthrottled network: three cold openings were 389 / 360 / 362 ms, median 362 ms. Each loaded two raw findings and four concept labels without starting the evidence engine. Raw results: `mobile.json`. The viewport distinction matters; the narrow-viewport throttled test above is the closer reproduction of the screenshot.
- `npm test` passed, including integrity, retry, request-sharing, snapshot-isolation, and every generated bundle's digest/finding-key/endpoint-coverage checks. The staging deployment build also passed.
- The versioned deployment build's 93-finding academic-achievement/cognitive-ability edge opened in 143 ms with two requests and no evidence-engine initialization. Next/Previous pagination passed. This is one local desktop run without throttling; raw results: `built.json`.

Rebuild using `node scripts/generate_evidence_panels.mjs findings.parquet compiled-dag.json search-catalog.json.gz snapshot-manifest.json`. The source publication is `c221423a-9470-4c82-8a3d-8bcf4a01ef7c`; canonical findings and the manifest remain under the existing immutable snapshot URLs. Rebuilding deterministically produces the index digest pinned in `site/evidence_panel_catalog.mjs`.

Run the mobile UI checks with `npm run test:browser -- tests/evidence_panel.spec.cjs`, adding `--browser=webkit` for Safari-engine coverage. Runtime byte checks and the fallback preserve compatibility with future snapshot changes; a new snapshot needs its own generated bundles and binding to gain the fast path.
