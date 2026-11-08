# Echo Viewer

The static viewer is deployed to [echo.epistemicinfra.org](https://echo.epistemicinfra.org) with GitHub Pages.

The deployable website is contained in `site/`. GitHub Pages uploads only that
directory, so repository-level files such as tests are not served publicly.

## Push secret scan

Run `npm run prepare` once in each clone to enable the versioned pre-push hook.
`npm install` also runs this setup. The hook checks the Git objects that a push
would send, including earlier commits in the outgoing history, and blocks
recognized credentials and suspicious hard-coded values. It reports locations
without printing the values. A normal push from the command line, a local agent,
or GitHub Desktop runs the hook in that checkout. Run `npm run check:secrets` to
scan the full current branch manually.

This is a local safeguard. A different clone needs its own hook setup, and Git
allows callers to bypass local hooks. Enable GitHub secret scanning push
protection for server-side coverage where available.

## Local agent operations

Run `npm run agent:mcp` to expose Echo operations to a local MCP client over
standard input/output. Node.js 22 and the `duckdb` command line program are
required. Configure the MCP client to launch that command from this repository.
The `echo_start` tool clones the current published schema and its pinned public
evidence snapshot by default. Pass `publicationId` and, when needed, a compatible
physical `snapshotId` to select a different starting point. `echo_clone` preloads
the data without starting a session; `echo_start` with `sync: false` starts from
an already cloned publication. Downloads are checked against the manifest's
SHA-256 hashes and the publication's canonical schema hash.

Agent sessions, public data clones, and Jev checkpoints live in `.echo-agent/`,
which is ignored by Git. Set `ECHO_AGENT_HOME` to move them elsewhere. All
evidence queries and graph calculations use the local clone. The Jev tools make
OpenRouter requests with an `OPENROUTER_API_KEY` supplied through the process
environment; they use the same model, prompts, result parsing, and spending-cap
check as the browser. No credential is written to a session file.

Before Jev pricing or classification, `echo_jev_estimate` and `echo_jev_test`
check the approved published split index for the selected source groups. If
matches exist, they return their names and descriptions without making an AI
request. The agent can apply one with
`echo_apply_published_split`, which verifies the published membership file and
current source assignments. If none fits, repeat the Jev estimate or test with
`useAIWhenPublishedAvailable: true`. `echo_browse_published_splits` also exposes
the lookup directly. An unavailable index is reported when Jev runs.

Use `echo_diff` to review the complete local revision and `echo_ready` to
validate and freeze it. `echo_publish` is the only publication tool. It uses
the Cloudflare publishing service to upload immutable files and register the
publication. It cannot be called a second time in that session and never runs
automatically. Supply `ECHO_OWNER_TOKEN` through the process environment to
publish from the agent. The token has the form `<owner uuid>.<64 hex>` and is
created by publishing once in the browser; keep it private.

Two optional checks challenge confounder statuses against the graph. Each is
off unless its variable is set to `1` in the MCP server's environment, and each
applies only to its own status. Both read the working graph's current links
(any link with at least one supporting paper), search only short routes, and so
cannot prove a claim, only find counter-evidence. When either is on, the rules
are also sent to the client in the MCP `initialize` instructions.

- `ECHO_CHECK_ONLY_VIA` checks `causes_y_only_via_x`. The call is refused while
  the graph holds a direct confounder → DV link, or confounder → z → DV through
  any group other than the IV. The agent repeats it with `rejectedPaths` naming
  every listed route (z's group ID, or `"direct"`; naming a route that was not
  listed is an error) and `text` explaining which link is not a real effect.
- `ECHO_CHECK_ADJUSTMENT` checks `not_in_minimal_adjustment_set`. Groups with
  status `explicitly_controlled` or `accounted_for_by_design` count as adjusted
  for. The call is refused while the confounder has a directed arm to the IV and
  a directed arm to the DV, each at most three links, sharing no group, through
  no adjusted-for group and not through the IV or DV (IV ← … ← K → … → DV).
  The agent repeats it with `text` saying which group blocks each listed route
  or why it is not a real causal path. The check only requires non-empty text.

The wording shown to agents is in `agent/diagnostic_checks.mjs`. Nothing in
the browser UI uses these checks.

The agent's finding decisions operate on individual raw causal links, matching
Echo's finding-level Exclude/Restore controls. There is no article-wide
exclusion operation.

To preview the site locally, run:

```sh
python3 -m http.server --directory site
```

## Jev-assisted variable splits

### Browse published user splits

The **Browse user splits** choice lists splits from the current owner's finished
publications for the selected source category or categories. Choosing a split
loads its membership file and opens an editable draft. Source assignments must
still match the current schema. New and edited split descriptions must contain
at least 20 characters. The owner token saved in this browser provides access
to the owner's list; retain the token to recover it in another browser.

In the variable definition partition step, describe the new side of the split
and choose **Connect OpenRouter**. The browser uses OpenRouter's PKCE flow and
keeps the returned user-owned key in memory for that tab. No application key or
server endpoint is involved. The browser checks `GET /api/v1/key` and enables
Jev only when the key has a non-resetting spending limit of at most $5 with a
positive balance. If necessary, use the key-settings link, lower the limit in
OpenRouter, and choose **Recheck limit**. This is a per-key cap; a new key has
its own limit.

**Test split** sends 24 randomly sampled source variables and the description
to OpenRouter's pinned `typesafe/jev-1.13` decision model. The sample stays
fixed while the user revises the description and reruns the test, so they can
inspect the effect of the wording. The app fetches Jev's current OpenRouter
pricing and estimates both runs before the test. After the test, its reported
input-token usage refines the estimate for the remaining variables. These are
estimates, not spending guarantees; OpenRouter determines the charge.
The map previews Jev's suggested new side after both runs and updates when a
full-run choice is corrected; the draft changes only when suggestions are applied.
**Run full split** classifies the remaining variables and reuses the test results.
The full preview opens on a bounded spot
check with lower-score, suggested-new, leftover, and paged all-results views.
Only the full preview offers editable new/leftover choices. **Apply full suggestions**
changes the draft only; the regular review and save controls still commit the split. Returning from
OpenRouter restores the unsaved partition from this browser's session storage.
Disconnecting removes the key from app memory; the OpenRouter key-settings link
remains available for revocation. Refreshing the page also clears the key from
app memory.

## Published schema source

Published schema files and registry rows are read from Cloudflare R2 at
`data.epistemicinfra.org/published-schemas/`. Registry rows are static files at
`published-schemas/_registry/<id>.json`; publishing and split browsing use the
Cloudflare Worker described in `docs/publishing-api.md`. Browser tests cache
immutable R2 files on disk in `.cache/published-schemas` to avoid repeated
large downloads. Publication references must use Cloudflare R2 URLs.

## Performance profiling

Run `npm run profile` to start a local preview and measure startup, definition
entry, group search, IV/DV selection and changes, map controls and gestures,
DAG layouts and filters, edge Exclude/Restore, undo/redo,
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
The viewer preloads metadata for up to 24 paper references through Crossref.
When exporting a document, it fetches metadata for every cited DOI, which can
take longer for large DAGs. References whose metadata cannot be fetched retain
their DOI in the exported bibliography.
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
4× CPU throttling and include 20% extra headroom. Firefox enforces interaction and readiness times; browser
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

### Selection and concept exclusion profile

Run `npm run profile:selection-concept` to profile DV and instrument selection,
opening a variable, and excluding a concept against a published schema. It records
visible feedback and settled graph times separately, captures long tasks and CPU
profiles, and checks that anchor selection reuses aggregated links. Set
`PROFILE_DEVICE=mobile` for a 4× CPU-throttled mobile viewport, `PROFILE_RUNS` to
change the run count, and `PROFILE_OUTPUT` to choose the output directory. The
default output is `/private/tmp/echo-selection-concept-profile`.

### Diagnostic view switching profile

`npm run profile:diagnostics` profiles the current source against the published
100k staging schema at a 390 × 844 mobile viewport with 4× CPU throttling. It
opens the mobile Map tab and measures cold and repeated switches between
exclusion restriction and exogeneity, plus bottleneck, path-link and all-visible-link controls.
The unit regression covers all graph filter controls, including the confounder,
collider and path-length controls hidden while an instrument is selected. Each step waits for the graph and two paint frames,
checks rendered evidence against the filtered graph, and rejects project
recompilation, membership changes or raw evidence loading during view switches.
Three fresh browser contexts run by default. Each interaction must finish within
500 ms with no main-thread task over 100 ms (desktop: 250 ms / 75 ms).

Use `PROFILE_DEVICE=desktop` for desktop, `PROFILE_RUNS=1` for a quick check,
`PROFILE_SITE_DIR=dist/site` for a built release, or `PROFILE_URL=<published-url>`
for other anchors and schemas. Local application assets are served by Playwright
on the chosen origin; remote evidence remains real. `PROFILE_REMOTE=1` measures
the deployed assets instead. URLs containing `local_schema` are rejected because
those drafts exist only in their original browser. `PROFILE_OUTPUT` changes the
output directory; `PROFILE_DISABLE_BUDGETS=1` records a diagnostic run without
timing gates. CPU profiles, timing summaries, and failure screenshots are saved
under `profile-results-diagnostics-mobile/` (desktop: `profile-results-diagnostics/`).
The PR/scheduled profiling workflow and staging and production deployments run this check.
