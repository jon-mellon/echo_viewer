# Select IV and group search investigation — 2026-10-26

Three fresh Chromium contexts per configuration, local Python static server,
1365×900 viewport, CPU profiler enabled. Throttled means 4× CPU throttling with
the same desktop viewport; this is not a physical mobile-device benchmark.
Times include Playwright interaction and two animation frames after completion.
No network throttling. Remote immutable evidence/publications load normally;
browser contexts have independent caches, but OS/network caches can be warm.

| Measurement | Original | New upload | New, 4× CPU |
|---|---:|---:|---:|
| Groups | 103 | 111 | 111 |
| Group member assignments | 14,284 | 97,818 | 97,818 |
| First education search, median | 70 ms | 72 ms | 183 ms |
| Repeat education search, median | 32 ms | 33 ms | 49 ms |
| Select IV, median | 148 ms | 295 ms | 898 ms |
| Select IV longest task, median | <50 ms | 156 ms | 603 ms |

The measured membership growth is 6.85×, despite the upload being described as
roughly 10× overall. Select IV is 2.0× slower, and visibly blocks the main thread
on slower CPUs. Desktop new-data IV range: 260–311 ms; throttled: 897–931 ms.
Repeat queries include income, education, health, a broad single letter, no
matches, and clearing the input. Desktop new-data results range 31–34 ms;
throttled results range 32–67 ms. These measurements include a roughly 33 ms
frame-wait floor and are not pure search computation times.

## Critical search correctness issue

The bundled catalog has 14,284 records in every configuration. Original schema
members have 14,284 matching catalog IDs; the new schema has **zero** matching
catalog IDs. At startup `variableById.size` is also zero. Consequently constituent
variable search does not work on a fresh new-data session: only group label
matches are available. Education finds 18 groups in the original and three in
the new schema, but those counts are not a valid performance/recall comparison
because the schemas differ and catalog coverage is missing.

`prepare_new_data_site.mjs` switches publication and evidence manifest but
symlinks the old `variable-search-catalog.json[.gz]`. The default catalog URL is
unversioned. The new-data search timings therefore do **not** establish that
full-catalog search scales to the new dataset.

## CPU evidence and improvements, in priority order

1. **Bind search catalogs to evidence snapshots and validate ID coverage.**
   Generate the catalog from the new snapshot's variables, and have the selected
   evidence manifest identify its catalog. A shared or alternate snapshot must
   never silently search a different snapshot's variables. Add a meaningful
   browser check using a constituent label absent from its parent group label.
   Reprofile after correcting coverage before claiming search scalability.
2. **Give anchor changes a cheaper project update path.**
   `dag_builder.js:applyProjectOperation` serializes the structural portion of
   both projects, copies all member arrays into `oldSchema`, and invokes project
   application/compiled-DAG update even when promoting an existing group only
   changes anchor roles. Preserve membership indexes and topology when their
   inputs are unchanged, while updating anchor-dependent candidates/filters.
   Avoid serializing the entire membership list to discover an anchor-only edit.
3. **Reduce synchronous work before the DV picker paints.**
   One representative new-data CPU profile samples ~152 ms in the IV handler:
   ~59 ms in promote/apply and ~80 ms in renderAll (inclusive figures, not
   independent sums). The latter includes publication refresh, export input
   capture, map and graph rendering. Defer export/bibliography preparation until
   requested and reuse publication canonical data when memberships are unchanged.
   Keep anchor selection, undo, persistence, and graph readiness consistent.
4. **Render the active picker once.** `renderAll` invokes renderSearch for both
   sides, which renders their setup pickers, then renders setup pickers again.
   This also duplicates search scans. Cache or consolidate the render pass.
5. **Use an index designed for group membership search.** Current group search
   scans and ranks the entire variable catalog, builds a result Map, then scans
   group member arrays and normalizes matching fields again. Cache normalized
   searchable fields and variable-to-group membership per schema revision; use
   an unranked matching path when only group membership is required. Preserve
   existing substring and field-match semantics. Consider a worker if the
   corrected larger catalog produces long tasks. With only 111 groups, picker
   virtualization is lower priority than eliminating whole-member processing.

No production behavior was changed in this investigation. Existing uncommitted
map-rendering changes were retained and are part of the measured working tree.
The full existing workflow profiler also completed on the new upload: group
search 85 ms, IV 417 ms, startup visible 2,242 ms, memberships ready 4,309 ms.
Its IV/search runs follow definition and map interactions, explaining why they
are not identical to the fresh focused scenario. No browser errors occurred in
the focused runs. CPU samples identify likely costs, not guaranteed savings.

## Reproduce

```sh
node scripts/prepare_new_data_site.mjs
PROFILE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-anchor-new node scripts/profile_anchor_search.mjs
PROFILE_OUTPUT=/private/tmp/echo-anchor-old node scripts/profile_anchor_search.mjs
PROFILE_SITE_DIR=dist/new-data-site PROFILE_DEVICE=mobile PROFILE_OUTPUT=/private/tmp/echo-anchor-new-throttled node scripts/profile_anchor_search.mjs
```

The script writes per-run CPU profiles and summary.json; committed JSON files
retain the raw measured results. `PROFILE_URL` selects an already running server;
`PROFILE_RUNS` defaults to three. Do not run multiple self-serving benchmarks
simultaneously: they use port 8768. The first populated group is selected for IV;
other group sizes/choices may differ.

## Implemented fixes and verification

The follow-up implementation now:

- Ships immutable, snapshot-declared catalogs for both evidence builds, including
  all 97,818 new IDs. Unknown snapshots query only their own evidence metadata;
  a mismatched snapshot or missing schema member raises an error. Historical
  logical evidence signatures resolve to their physical snapshot directories,
  including when a publication is opened on a deployment with another default.
- Parses static catalogs in a module worker and transfers 2,000 records per
  message with acknowledgement/backpressure. Main-thread field indexing also
  yields between batches. This preserves synchronous search behavior while
  avoiding a single large JSON parse on the UI thread.
- Caches normalized constituent fields, membership ownership, and the last four
  group queries. Group search does not rank every matching raw variable or sort
  that entire result set. Hydrated field precedence, substring semantics, group
  order, and first matching constituent are preserved.
- Detects anchor-only operations using shared input identity. These operations
  preserve compiled evidence and memberships, avoid whole-member serialization,
  copying, ownership comparison, and incremental recompilation, and leave
  anchor-dependent candidate/filter rendering intact. Full undo snapshots remain.
- Renders each setup picker once per full UI update. Export preparation and
  bibliography fetching now occur only through export actions, and anchor role
  changes do not trigger publication hashing. Split definition exports keep
  view-only anchor roles/timestamps out of their changing metadata.

Final three-run medians:

| Measurement | New data before | Fixed desktop | Fixed 4× CPU |
|---|---:|---:|---:|
| Select IV | 295 ms desktop / 898 ms throttled | 153 ms | 357 ms |
| IV longest task | 156 ms desktop / 603 ms throttled | 58 ms | 239 ms |
| First education search | 72 ms, incomplete catalog | 681 ms | 1,021 ms |
| First search longest task | Not comparable | <50 ms | 111 ms |
| Repeat education search | 33 ms, incomplete catalog | 33 ms | 49 ms |
| Education results | 3 label matches | 44 groups | 44 groups |
| Catalog coverage | 0 / 97,818 | 97,818 / 97,818 | 97,818 / 97,818 |

First search now loads the correct 7.2 MiB compressed / 45.8 MiB JSON catalog;
its latency cannot be compared with the previous incorrect small catalog.
The worker reduced the corrected catalog's throttled first-search stall from
312 ms median without the worker to 111 ms. Worker desktop runs had no >=50 ms
first-search tasks. Across desktop warm queries, observed wall times were
32–51 ms. Throttled uncached/broad queries sometimes take longer; background
lazy map/evidence setup also overlapped health search in two runs (272 ms task),
so aggregate interaction timings are not pure search execution costs.

Each final run verifies a constituent-only query (`verbal number skills` finds
academic achievement), complete catalog coverage, compiled-DAG identity reuse,
and anchor history restoration. Undo uses the visible toolbar; redo dispatches
the ordinary redo control's click handler because undoing the only anchor hides
the DAG toolbar. These are history behavior checks, not an assertion that every
history control remains visible in every setup state.

Final measurements use the standard allowed evidence origin, 127.0.0.1:8767,
with local application assets fulfilled from this working tree through
Playwright context routing (`PROFILE_ROUTE_SITE_DIR`). This isolates the test
from another task's preview server without altering remote evidence requests.
Local request interception disables HTTP cache; first-load timings include this
harness overhead. Final focused runs have no page errors. Earlier port-8768
runs encountered the evidence host's CORS restriction; those diagnostic runs
are excluded from the final files. CPU profiles remain under
/private/tmp/echo-anchor-worker-{desktop,throttled}.

```sh
PROFILE_URL=http://127.0.0.1:8767/ PROFILE_ROUTE_SITE_DIR=dist/new-data-site PROFILE_VERIFY_HISTORY=1 PROFILE_OUTPUT=/private/tmp/echo-anchor-worker-desktop node scripts/profile_anchor_search.mjs
PROFILE_URL=http://127.0.0.1:8767/ PROFILE_ROUTE_SITE_DIR=dist/new-data-site PROFILE_DEVICE=mobile PROFILE_VERIFY_HISTORY=1 PROFILE_OUTPUT=/private/tmp/echo-anchor-worker-throttled node scripts/profile_anchor_search.mjs
```

The self-serving benchmark defaults to port 8767, configurable with PROFILE_PORT,
and now fails if that port is occupied rather than silently measuring another
build. The original baseline above used port 8768. Existing unrelated changes
were preserved; concurrent work on the shared checkout may affect background
rendering timings, so these results are local measurements rather than universal
performance guarantees.

Validation: `npm test` passes. The complete desktop workflow profiler completed
all 41 scenarios, including definitions, IV/DV selection, filters, edge decisions,
history, and project/map/grouping downloads. Its first group search took 670 ms
with no >=50 ms main-thread task; IV took 198 ms. See fixed-full-workflow.json
for the exact scenario and budget results. No browser errors were reported.

## Second optimization pass

The next pass reduces work further:

- Search first rejects entire negative groups with a cached native substring
  check, then verifies candidates in membership/field order and stops at the
  first constituent match. This preserves label priority, literal substring
  matching, and hydrated metadata precedence. Per-group positive/negative hits
  are cached for sixteen queries; membership changes invalidate them.
- Catalog batches build their field indexes as they arrive from the worker,
  eliminating a second timer-driven pass. Group search indexes and coverage
  checks prepare in short slices before the UI reports search ready.
- Anchor changes record compact role/decision history rather than serializing
  all memberships twice. Full membership edits retain full snapshots. Tests
  cover persisted mixed full/compact history across undo/redo.
- Clearing an absent hover no longer synchronously redraws the whole DAG, and
  an imminent DAG render coalesces hover restoration into its own repaint.
- Empty variable maps skip centroid membership scans. Populated centroids use
  one pass and preserve duplicate-representative weighting and missing-value
  behavior.
- Raw evidence engine startup now waits for explicit detail/definition/export
  intent. The previous speculative startup caused a large lookup conversion to
  overlap searches and anchor clicks. This may shift a one-time engine startup
  delay to the first raw-evidence operation; those operations still use the
  existing on-demand/prewarm paths.

Three fresh contexts per configuration, same correct catalog and routed preview
origin as the previous final measurements:

| Median wall time | Previous fixed version | Further optimized |
|---|---:|---:|
| Desktop first search | 681 ms | 363 ms |
| Desktop Select IV | 153 ms | 124 ms |
| Throttled first search | 1,021 ms | 634 ms |
| Throttled Select IV | 357 ms | 239 ms |
| Throttled broad `e` query | 133 ms | 49 ms |
| Throttled no-match query | 64 ms | 49 ms |

All desktop focused interactions had no >=50 ms task. First search also had no
>=50 ms task in the final throttled runs; throttled IV's longest task fell from
239 ms to 138 ms median. The broad-query gain includes avoiding allocation and
processing of every matching constituent. Timings retain the two-frame wait
floor and are local measurements; the unchanged catalog's 7.2 MiB transfer still
makes first search network-dependent in production.

All focused runs retain complete 97,818-ID coverage, constituent-only search,
compiled-DAG identity reuse, and history checks. The full 41-scenario workflow
profile completed again; exact results are in faster-full-workflow.json. Raw
three-run measurements are in faster-desktop.json and faster-throttled.json.
CPU traces remain in /private/tmp/echo-faster-{desktop,throttled,full}.
