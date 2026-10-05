# Echo Viewer

The static viewer is deployed to [echo.epistemicinfra.org](https://echo.epistemicinfra.org) with GitHub Pages.

The deployable website is contained in `site/`. GitHub Pages uploads only that
directory, so repository-level files such as tests are not served publicly.

To preview the site locally, run:

```sh
python3 -m http.server --directory site
```

## Performance profiling

Run `npm run profile` to start a local preview and measure startup, definition
entry, group search, IV/DV selection and changes, map controls and gestures,
DAG layouts and filters, edge Exclude/Restore, manual edges, undo/redo,
fullscreen, history, incident-link retrieval for 40 changed variables, and
project/schema downloads in Chromium.
Run `PROFILE_DEVICE=mobile npm run profile` for the same flows at a 390-pixel
viewport with 4× CPU throttling. Run `PROFILE_BROWSER=firefox npm run profile`
to check the same interactions in Firefox. Run `PROFILE_SCENARIO=permalink npm run profile`
to time the published permalink's graph and full group-membership load; combine
it with `PROFILE_DEVICE=mobile` or `PROFILE_BROWSER=firefox` for those browsers.
All six suites run on every pull request and before a GitHub Pages deployment.
`npm run test:browser` additionally checks the password gate, definition
Back/Cancel/Save/edit flows, public link sharing, project import/export, and
bibliography, Markdown, and LaTeX downloads. It runs in the same required jobs.
Document exports enrich at most 24 paper references through Crossref so a
large DAG does not wait for thousands of rate limited requests; every DOI remains
in the exported bibliography.
Each run writes a summary and Playwright trace to its browser-specific results
directory. Chromium also writes a CPU profile. Open that profile in Chrome
DevTools Performance, or inspect a trace with
`npx playwright show-trace profile-results/playwright-trace.zip`.
The suites also run every Monday in GitHub Actions; download the one-day
`viewer-profile` artifact to inspect a failing synthetic run. Set `PROFILE_URL` to
profile another deployment. Only profile a deployment where you have access;
the script uses the preview's session gate and does not submit a password.
The scenarios include the edge inspector's Exclude action and verify that the edge
disappears promptly, then that the graph finishes updating. The run fails if a
profiled interaction exceeds its scenario budget, an
interaction produces a long task or slow input event, or startup exceeds its
visibility, largest paint, schema readiness, long task, transfer, or layout
shift budget. Schema readiness is capped at 8 seconds on desktop and the
membership wait after the first paint at 4 seconds. Mobile budgets account for
4× CPU throttling. Firefox enforces interaction and readiness times; browser
metrics unsupported by Firefox are reported as unavailable. Use
`PROFILE_DISABLE_BUDGETS=1` for a diagnostic run without those gates.
Edge decisions reuse existing routes and update changed graph segments; the
profile fails if they trigger a full layout or routing pass. The definition
dialog starts the evidence query engine while a source is chosen. Use
`PROFILE_DEFINITION_THINK_MS=1000 PROFILE_DISABLE_BUDGETS=1 PROFILE_OUTPUT=profile-results-warm npm run profile`
to measure that warm path;
the required default run still measures an immediate Continue click.
The definition map loads variable records first, then queries optional neighbor
suggestions only for selected variables. The browser interaction suite checks
that order, and the profiler times the selection step.
Incremental group edits read incident links from the canonical Parquet snapshot
when available. The browser suite checks that path and its returned links; the
profile suite enforces a retrieval-time budget. Older manifests use the sharded
source and target files.

The suite uses synthetic browser sessions only. It does not collect viewer
analytics or retain user activity.
