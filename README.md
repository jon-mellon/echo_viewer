# Echo Viewer

The static viewer is deployed to [echo.epistemicinfra.org](https://echo.epistemicinfra.org) with GitHub Pages.

The deployable website is contained in `site/`. GitHub Pages uploads only that
directory, so repository-level files such as tests are not served publicly.

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

Use `echo_diff` to review the complete local revision and `echo_ready` to
validate and freeze it. `echo_publish` is the only publication tool. It invokes
the same immutable Supabase Storage uploads and registry insert as the site's
Publish action and cannot be called a second time in that session. This is one
final publication action, though Echo's publication format consists of multiple
Storage writes followed by one registry write. An agent session never publishes
automatically. By default, Supabase creates a private anonymous session, as
the browser does. To reuse an existing Supabase identity, supply both
`ECHO_SUPABASE_ACCESS_TOKEN` and `ECHO_SUPABASE_REFRESH_TOKEN` through the
process environment. Do not put credentials in this repository.

The agent's finding decisions operate on individual raw causal links, matching
Echo's finding-level Exclude/Restore controls. There is no article-wide
exclusion operation.

To preview the site locally, run:

```sh
python3 -m http.server --directory site
```

## Jev-assisted variable splits

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
