# Individual finding exclusion profile

Existing `profile_viewer.mjs` measures whole-edge exclusion. This focused profile measures opening an individual finding exclusion form, confirming exclusion, and restoring from the Excluded findings list. Each measurement includes two animation frames and records wall time and longest browser task. CPU recording covers these interactions, after evidence has loaded.

```sh
node scripts/prepare_new_data_site.mjs
node scripts/profile_finding_exclusion.mjs
```

Defaults to three fresh Chromium contexts against `dist/new-data-site`, port 8768, writing summary.json and cpu-0.cpuprofile (etc.) under `/private/tmp/echo-finding-exclusion`. Set `PROFILE_OUTPUT`, `PROFILE_RUNS`, `PROFILE_PORT`, `PROFILE_URL`, or `PROFILE_SITE_DIR` to override. `PROFILE_DEVICE=mobile` applies 4x CPU throttling with the same desktop viewport.

Requires at least 90,000 group members and records the actual evidence snapshot. Public evidence requests use a Playwright proxy because the data host rejects localhost Origin headers; network timings therefore include proxy overhead. No performance budget is imposed before a baseline is established.

The individual-finding scenario measures decision feedback. The final-support scenario explicitly verifies edge removal and restoration in both the compiled and rendered graphs.

Restoration is exercised through the Excluded findings list, where the finding remains accessible even after its original evidence-table page changes.

The original failure involved re-fetching a finding already loaded by the inspector, followed by a full candidate-queue rebuild over the 100k schema. The fix reuses the cached record and refreshes only edge-related UI for finding decisions.

## Initial desktop baseline (three runs, before the fix)

97,818 members in 111 groups. Median wall times:

- open finding exclusion: 51.2 ms; longest task at most 0 ms.
- exclude finding to visible feedback: 174.7 ms; longest task at most 109 ms.
- restore finding to visible feedback: 149.8 ms; longest task at most 110 ms.

Those initial timings checked inspector feedback before the evidence table refreshed. A post-fix run measured 189.6 ms for exclusion feedback, 115.9 ms to open Excluded findings, and 234.2 ms for restoration feedback. CPU traces remain in `/private/tmp/echo-finding-exclusion/cpu-{0,1,2}.cpuprofile`.

## Final supporting finding

```sh
PROFILE_SCENARIO=final-support PROFILE_RUNS=1 node scripts/profile_finding_exclusion.mjs
```

Selects a rendered, non-target edge with exactly one present supporting finding across both directions, then excludes that specific finding through the UI. Requires the compiled DAG to finish updating, remain valid, and omit the edge; separately requires the rendered edge to disappear. It does not substitute inspector feedback for edge removal. Output defaults to `/private/tmp/echo-finding-final-support`. The scenario then restores the finding from the Excluded findings list and verifies that the edge returns to the compiled and rendered graphs.

**Validation: passed.** Three Chromium runs against the new 97,818-member schema excluded finding `r8e4930302d2b7964bdeeacb0` from `category-academic-achievement__category-aesthetic-evaluation`. Each run verified that the compiled graph was valid, the edge was absent from it, and the rendered edge disappeared; restoring the finding brought the edge back to both graphs. Median time from confirmation to edge removal plus two animation frames: 226.6 ms; median restoration time: 214.3 ms. The 37 focused compiled-DAG, controller, and coordination tests and the type check also pass.
