# Faster path expansion and definition entry

Follow-up to staging commit `9c80363`. Same publication
`c221423a-9470-4c82-8a3d-8bcf4a01ef7c` and evidence snapshot
`f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`.

## Complete workflow profiles

Chromium, real remote data, desktop 1365×900 and mobile 390×844 with 4× CPU
throttling. Each complete-workflow column is one fresh-context run; network and
OS cache variation affect wall time. Before measurements are saved in
`../interface-2026-10-26/`.

| Metric, ms | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | ---: | ---: | ---: | ---: |
| Path-length expansion | 1320 | 568 | 2870 | 1411 |
| Path-length longest task | 151 | 104 | 622 | 446 |
| Definition source entry | 1942 | 1961 | 2161 | 1732 |
| Definition entry longest task | 72 | 58 | 266 | 216 |
| Initial DV selection | 238 | 138 | 1048 | 554 |
| Startup graph routing | 1066 | 311.4 | 1328.1 | 408.1 |

Both complete suites pass their existing budgets with no browser errors. Desktop
cold definition wall time is essentially unchanged; mobile definition entry is
about 20% faster in these complete runs. First path expansion remains above one
second on throttled mobile, although its cost is roughly halved.

## Focused mobile measurements

The focused benchmark uses a localhost CORS proxy, so timings include that
transport overhead. It measures a cold definition, selects the first two anchors,
then exercises the same filter sequence as the full profiler before expanding
and shrinking the collider path limit. The graph expands from 13 nodes / 76 edges
to 104 nodes / 2,603 edges (before the display-only Other-group filter).

One baseline context versus medians of three after contexts:

| Action, ms | Before | After median |
| --- | ---: | ---: |
| Cold definition source entry | 3013.8 | 2271.0 |
| First path expansion | 2655.1 | 1264.6 |
| Shrink back to one edge | 626.2 | 212.1 |
| Repeat expansion | 1097.4 | 738.7 |

After cold definition entry ranges from 2191.8–2619.2ms, so network variation
still matters. After first expansion ranges from 1264.5–1272.5ms. Every repeated
transition verifies that the actual rendered logical edges exactly match the
current filtered graph, including removal of stale edges.

## Implementation

- The existing intersection-based routing acceleration does not implement the
  current distance-weighted parallel-overlap rule and was falling back to a full
  scan of all previously routed segments. CPU replay attributed about 95% of
  routing time to that scan. The new orientation index skips unrelated headings,
  applies the exact existing distance/length tests, and sums surviving
  contributions in their original order. It preserves candidate ties and routes.
- On the captured 2,603-edge graph, Node replay routing falls from roughly
  1.44–1.55 seconds to 0.51–0.54 seconds after initial compilation. Before/after
  route JSON is byte-identical, SHA-256
  `b196ff88413afa693445d437fc5c89c61d87906ba2117c04f57893b09f3360eb`.
- Large graph transitions bind replacement DataSets once while retaining the
  same vis-network instance and handlers. Smaller edits retain incremental
  updates and the existing route-reuse path.
- Definition prewarming fetches lookup, build metadata and layout files in
  parallel with WASM startup when manifest sizes are at most 4MiB each. Buffers
  are installed only after verifying their declared byte counts and SHA-256.
  Unsupported or unavailable prefetches retain the remote Parquet path.
- Shard lookup is scoped to requested IDs and coalesces concurrent requests;
  explicit default initialization still loads the complete lookup. Arrow columns
  are indexed directly, yielding between large batches. Raw-link queries avoid
  unrelated variable lookup work.
- Large variable ID lists use a single bound JSON list rather than thousands of
  scalar bindings. Definition map queries omit unused JSON blobs while retaining
  labels, provenance, canonical IDs, layout positions and ordering.

## Validation and reproduction

`npm test` passes, including randomized exact scoring comparisons with reversals,
angular wraparound, distance/length boundaries and pruning cutoffs. Four browser
checks pass: canonical split editing, Back/Cancel navigation, original snapshot
retrieval, and content-ID retrieval. The latter checks concurrent partial lookup,
missing IDs, expansion to all 97,818 entries, all three verified prefetched files,
and lightweight/full record equivalence for 40 variables.

```sh
node scripts/prepare_new_data_site.mjs
PROFILE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-next-desktop npm run profile
PROFILE_DEVICE=mobile PROFILE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-next-mobile npm run profile
PROFILE_RUNS=3 PROFILE_DEVICE=mobile PROFILE_OUTPUT=/private/tmp/echo-next-focused node scripts/profile_definition_and_paths.mjs
```

Run benchmarks sequentially to avoid CPU contention. Complete profiles use port
8767; the focused script uses 8782 (overridable with `PROFILE_PORT`). The focused
script saves worker inputs for computation replay and CPU profiles for graph
application. This run's complete traces remain under
`/private/tmp/echo-next-full-desktop` and `/private/tmp/echo-next-full-mobile`;
focused CPU profiles are under `/private/tmp/echo-next-final-mobile`.
