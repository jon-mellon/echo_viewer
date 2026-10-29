# Restoring headroom under the original performance cutoffs

2026-10-26, new-data snapshot `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`, 111 groups and 97,818 memberships. Full Chromium profiles with local working-tree assets routed onto the allowed evidence origin and ordinary remote data requests. Desktop is unthrottled; mobile is 390 × 844 with 4× CPU throttling. Baseline and final full-suite runs are sequential; intermediate concurrent smoke runs are not used in these comparisons. Other unrelated working-tree changes were present and are excluded from this commit.

Both final suites pass every `originalLimits` comparison and every existing CI budget with no browser errors. The cutoffs were not changed. The before desktop run failed five original comparisons; mobile passed but had little headroom on several interactions.

| Measurement | Before | After | Original cutoff |
|---|---:|---:|---:|
| Desktop DAG fullscreen/Escape event | 208 ms | 24 ms | 150 ms |
| Desktop DAG fullscreen/Escape longest task | 188 ms | 0* | 150 ms |
| Desktop exclude-edge event | 152 ms | 56 ms | 150 ms |
| Desktop restore-edge event | 144 ms | 64 ms | 150 ms |
| Mobile exclude-edge event | 384 ms | 120 ms | 400 ms |
| Mobile restore-edge event | 368 ms | 136 ms | 400 ms |
| Mobile restore-excluded-edge event | 368 ms | 144 ms | 400 ms |
| Mobile startup longest task | 562 ms | 433 ms | 600 ms |
| Mobile path-expansion longest task | 450 ms | 434 ms | 500 ms |

*Zero means no task exceeded the browser's 50 ms long-task reporting threshold.

The strongest gains come from keeping link display decisions separate from compiled evidence ownership: excluding/restoring an aggregate link does not scan memberships or reconstruct compiled occurrence counts. The existing aggregate pass applies the decision to the unchanged evidence graph. Browser tests verify compiled-object and membership-array identity across Exclude/Restore, as well as restored decisions and findings.

Fullscreen now resizes and fits the existing network instead of reapplying graph data. It resizes the variable map only when entering/leaving that map's fullscreen view. DataSet mutations already request a vis.js paint, so edge updates no longer force an additional synchronous paint inside their event. Routing bends use empty text anchors rather than drawing transparent circles. Large node-count transitions skip per-bend JSON comparisons when replacement is already guaranteed.

Provenance classifications index only requested endpoints; ownership is built only when excluded findings require it. The variable map likewise indexes its hydrated variables rather than allocating ownership for all snapshot members. Membership hydration yields before its DOM/canvas refresh and keeps editing locked until that final stage is ready.

Remaining margins should not be overstated. The final desktop cold definition-source selection took 2,460 ms against 2,500 ms and remains network-sensitive. Mobile definition closing took 344 ms against a 400 ms event cutoff, changing IV took 336 ms against 400 ms, path expansion took 434 ms against 500 ms, and measured startup transfer was 2.1 MiB against 2.5 MiB. These are individual full-suite runs, not percentile guarantees. Earlier isolated mobile experiments recorded path tasks of 422–449 ms and startup tasks of 433–492 ms. The observed startup/network metrics are specific to the harness and should not replace physical-device checks.

Validation: `npm test` passes; six focused Chromium browser cases pass across cold/corrupt evidence bundles and both snapshots. A stale network-listener test mock was updated to support multiple handlers per event, matching the recently added graph-touch listeners. Fullscreen resizing, scoped/overlapping classifications, and map ownership have focused unit coverage. Full profiles verify graph rendering, Exclude/Restore, Undo/Redo, and definition navigation. Raw before/after results are included; CPU traces remain under `/private/tmp/echo-cutoffs-*`.

Reproduce after `node scripts/prepare_new_data_site.mjs`:

```sh
PROFILE_URL=https://echo.epistemicinfra.org/ PROFILE_ROUTE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-cutoffs-desktop npm run profile
PROFILE_URL=https://echo.epistemicinfra.org/ PROFILE_ROUTE_SITE_DIR=dist/new-data-site PROFILE_DEVICE=mobile PROFILE_OUTPUT=/private/tmp/echo-cutoffs-mobile npm run profile
```
