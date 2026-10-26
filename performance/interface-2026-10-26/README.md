# Interface responsiveness — 2026-10-26

New-data publication: `c221423a-9470-4c82-8a3d-8bcf4a01ef7c`.
Evidence snapshot: `f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b`.

The working tree initially could not start: a nested export and duplicate local
declaration in dag_network_controller.mjs caused syntax errors. Those are fixed.
The before measurements use the committed implementation with the new-data IDs;
the after measurements use the working tree. Each column is a single Chromium
run against real remote data, not a statistical regression estimate. Mobile uses
a 390px viewport and 4× CPU throttling. Network and cache variation affect times.

| Metric (ms) | Desktop before | Desktop after | Mobile before | Mobile after |
| --- | ---: | ---: | ---: | ---: |
| Startup longest task | 363 | 176 | 1275 | 542 |
| Change IV | 265 | 167 | 2575 | 876 |
| Change DV | 167 | 166 | 2344 | 748 |
| JSON export longest task | 168 | 0* | 613 | 103 |
| JSON export elapsed | 299 | 348 | 780 | 460 |
| Definition source selection | 1971 | 1942 | 2777 | 2161 |
| First path-length expansion | 1303 | 1320 | 2767 | 2870 |

*Zero means no task exceeded the browser's 50ms long-task threshold.

Retained changes:

- Send only labels and topology to the graph worker. Attach current evidence
  records after computation instead of cloning memberships and finding arrays.
- Cache eight complete graph geometries by their actual layout inputs. Rebind
  current link metadata on reuse; reject changed endpoints or directions.
- Normalize duplicate ownership in one pass rather than scanning all ownership
  entries for each group.
- Cache canonical membership sorting, checking for in-place membership edits
  and invalidating when the duplicate-cluster index changes.
- Build evidence ownership only when finding decisions require it.
- Calculate each routed edge's title and style once, rather than once per bend.
- Serialize JSON exports in a worker, with a fallback for unavailable workers.
- Yield within large categories during asynchronous anchor-index preparation.

Both complete profiles passed their current performance budgets without browser
errors. These gates have more headroom than the original baselines; passing does
not mean every interaction is instantaneous. First path-length expansion remains
about 2.9 seconds on throttled mobile, with a 622ms task. Cold definition loading
still takes about 2.2 seconds. Edge exclusion/restoration remains about 0.6–0.9s
on throttled mobile. These are the remaining priorities.

Validation: `npm test` passed, followed by focused layout/routing/search/controller
tests after the final changes. Four targeted browser checks passed: canonical
definition editing, Back/Cancel navigation, export/import, and stale draft
revision handling. A fifth check fails at the public-version link's missing
anchor parameters; the identical failure was reproduced against committed HEAD
`e04d8c6` using the same browser test and original default data configuration.

Reproduce:

```sh
node scripts/prepare_new_data_site.mjs
PROFILE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-perf-desktop npm run profile
PROFILE_DEVICE=mobile PROFILE_SITE_DIR=dist/new-data-site PROFILE_OUTPUT=/private/tmp/echo-perf-mobile npm run profile
```

Run profiles sequentially because the harness uses port 8767. Summary files are
saved alongside this report. Full traces and CPU profiles for this run are in
`/private/tmp/echo-perf-release-desktop` and `/private/tmp/echo-perf-release-mobile`.
