# Echo Paper Review 0.2.0

The implementation lives on `permastaging`. The extension is a
small Manifest V3 shell. Its side panel embeds `https://www.jonathanmellon.com/echo_viewer_permastaging/paper-review.html`.
The browser runs the review in that web page, using the existing static data and
publication service. There is no evaluation server or remote MCP endpoint.

## Build and install

### Test from the permanent preview branch

Once the **Deploy Echo Permastaging** workflow and its GitHub Pages build succeed,
open <https://www.jonathanmellon.com/echo_viewer_permastaging/extension.html>.
Download its ZIP, unzip it, and load the extracted folder using Chrome's
Developer mode **Load unpacked** control. The permastaging deployment builds this
package with `npm run build:extension:permastaging`, so its review frame opens the
permastaging page on the already allowed `www.jonathanmellon.com` origin.
It does not depend on a production deployment. You will need your own capped
OpenRouter key for the initial connection. Echo chooses the pipeline models
internally; the user only chooses the claim to evaluate. This remains a preview whose live real-paper evaluation is unverified.

### Local permastaging package

1. Run `ECHO_PAPER_REVIEW_ENABLED=1 npm run build:site` for a permastaging or local
   development build. The new `paper-review.html`, `paper-auth.html` and
   their modules must be deployed together. **They are not deployed by the extension build.**
2. Run `npm run build:extension:permastaging` (the default extension build also targets permastaging).
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select `dist/extension`.
4. Open an HTML paper and click the Echo toolbar action. This grants temporary
   tab access and automatically captures and saves its metadata and text. Review
   the captured details; corrections remain available in the expandable form.
5. Connect a capped OpenRouter key once. Abstract claim extraction runs
   automatically. Choose a claim; qualification, variable setup, split handling
   and evidence review run automatically. No model selector or step buttons
   are required in the normal flow.

To update an installed unpacked extension, replace its folder contents with the
new ZIP and click **Reload** on its card in `chrome://extensions`.

The extension has only `activeTab`, `scripting`, `sidePanel` and `storage` permissions. It
has no persistent article-host access, API-host access, ambient tab tracking,
or externally-connectable command interface. Clicking the toolbar
action captures that article automatically. Opening Chrome’s side-panel picker
does not grant activeTab; the panel explains how to invoke the toolbar action
instead. Restricted Chrome pages and inaccessible PDFs remain unsupported.
PMC HTML with an abstract, methods, results and discussion is recognized as full
article text when no selection or truncation occurred. Other pages remain
partial until the user confirms their coverage. When connected, capture triggers
automatic abstract extraction. Qualification and evaluation wait for claim choice.

## Production release gate

`permastaging` is not promoted into `staging` or `main`. Both release branches require the GitHub Actions `profile` check, and that check fails for any commit descending from the extension isolation root (`e05fbe0b8e51447b92ec4ed0123a3c42bc6d0a0c`). Renaming a branch does not bypass ancestry detection. Repository rules have no bypass actors. Permastaging itself cannot be force-pushed or deleted.

Even if the files are copied into `main`, production does not enable the preview.
`build:site` excludes the install page, review/auth pages, all `paper_*` modules,
review CSS and any extension ZIP by default. Only the permastaging workflow sets
`ECHO_PAPER_REVIEW_ENABLED=1`; the production workflow does not package an extension.
The browser entry point and OAuth callback also reject the production domain,
including if raw source files are served accidentally. The only web deployment
allowed at runtime is the exact permastaging origin/path; localhost is allowed for
development. Extension builds target permastaging by default and reject an explicit
production target. Changing a URL or query parameter cannot enable production.

This is a release gate, not invite-only authentication. The permastaging website and
its download are public. Named-testers-only access would require authentication
at the permastaging host. Enabling a future production release requires deliberately
changing the runtime host rule as well as the build/deployment configuration.

## Why requests go through the Echo origin

The iframe is a real Echo web document, not a reverse proxy. Its fetches and
DuckDB worker requests have the Echo origin/referrer and use the existing
Cloudflare allowlists. Its scripts and WASM execute inside Echo's web context;
the privileged extension shell only uses packaged JavaScript. The frame has a
sandbox with scripts, same-origin web behavior, forms, downloads and escaping
popups enabled. It cannot access extension APIs or the parent DOM. The authenticated Echo frame can ask the shell to remember or forget its capped
key. It cannot ask the shell to fetch, run scripts, read tabs or publish.

Capture messages require the exact frame/opener, expected origin and a random
per-panel nonce. The readiness message contains only the nonce. Article text
is sent using an exact Echo target origin. The receiver validates and bounds the
capture. Each new article starts a separate saved review; it never changes the
evidence in an earlier run. Captures arriving during an active step are deferred
until the user finishes/cancels and invokes capture again.

Live header probes on 2026-11-15 found:

| Probe | Observed result |
| --- | --- |
| `data.epistemicinfra.org` manifest with extension Origin, no Echo Referer | HTTP 403 |
| Same manifest with Echo Origin and Echo Referer | HTTP 200 and `Access-Control-Allow-Origin: https://echo.epistemicinfra.org` |
| `echo-api.epistemicinfra.org/v1/splits` with extension Origin | HTTP 200, without an Allow-Origin header |
| Same API route with Echo Origin | HTTP 200 with Echo Allow-Origin, methods and headers |
| Echo homepage headers | HTTP 200; no X-Frame-Options or CSP frame-ancestors restriction observed |

The checked-in Worker configuration in the companion `harvest_abstracts` repo
lists Echo and the Jonathan Mellon web domains, without extension origins.
Its origin function sets CORS headers; it does not reject an unlisted origin
as authentication. The data-host 403 is a separate server-side restriction.
No Cloudflare Access login redirect was observed in these probes. These checks
do not identify every dashboard WAF/Access rule or promise future settings.

**With this architecture, no extension-origin CORS/allowed-domain change is
needed.** Keep Echo's origin allowed on the data host, API and Turnstile widget.
Do not add a blanket wildcard or spoof Origin/Referer headers. If framing or
third-party storage is blocked, use **Open Echo tab**. A future Cloudflare
challenge/Access login can also require that top-level tab. If deployment adds
`frame-ancestors 'self'` or `X-Frame-Options: SAMEORIGIN`, the embedded mode will
need a deliberate exception or the tab fallback. Website review modules must
remain web content isolated from Chrome privileges; Web Store distribution
still requires its normal policy review.

## Shared operations and review limits

`site/echo_session_core.mjs` and `site/echo_tools.mjs` contain the shared domain
operations/tool contracts previously in the Node agent. `agent/session.mjs`
and `agent/tools.mjs` remain filesystem/environment/transport adapters. The
browser adapter verifies a complete published schema and evidence metadata,
pins the physical snapshot and manifest hash, and applies incremental compiled
graph updates. It retrieves explicit findings and changed-variable incident
links rather than scanning every raw link. Target-pair orientation is refreshed
when anchors change. Touched edges can omit paper-count caches; finding IDs,
decision effects and confounder diagnostics must agree with full compilation.

The first version provides:

- Pipeline variable/link extraction, user claim choice and automatic selected-claim qualification.
- Exact article quotations for the focal estimate and adjustment description;
  unsupported designs, missing full text and invalid qualifications stop work.
- Model-directed group search, published-split lookup, existing split operations,
  Jev estimate/test/full/override/apply and focal-anchor checks for exact matches.
- A pinned distance-one evidence queue with endpoint metadata. Per-link ordering,
  distinct-paper five-finding stops, focal-paper exclusion, controlled/design
  exceptions, short-leg termination and coverage validation use browser ports
  of the reference review contract. Blank DOIs cannot count as independent papers.
- Meaning-difference assessments, explicit split resolution with graph rebuild,
  and a three-resolution limit. Review does not complete while a split is required.
  Per-run miscoding flags enforce the reference greater-than-one-quarter failure
  threshold for new split membership; flags survive evidence requeues.
- This checkout's **six** confounder statuses and its enabled only-via graph
  check. The newer reference file in the companion checkout has eight statuses;
  construct-duplication statuses are intentionally unavailable, not silently
  mapped to statistical adjustment. Minimal-adjustment explanations remain
  prompt judgments, as in the reference runner's disabled adjustment check.
- Private result/usage inspection and JSON checkpoint export. Publication is
  available only after completion, readiness and a visible public projection.
  It uses the existing owner token, Turnstile, public projection and immutable
  publication flow. No publish tool is exposed to the model.

This is a preview implementation, not a claim of complete demonstration parity.
There is no parallel reviewer-fragment orchestration; review is sequential.
Finding-history and miscoding registries are explicitly unavailable rather than
imported from another user or the local machine. Focal-variable discovery uses
bounded DOI search and exact measurement-label matches; unlocated occurrences
are reported as unverified, not proof that the paper is absent. Novel model
judgments and splits still require human inspection. Very large contexts can
exceed a selected model's capacity; failures remain incomplete rather than
silently truncating evidence. No live model-cost/cache benchmark is included.

## Authentication, checkpoints and interruption

OpenRouter PKCE generation/exchange and capped-key validation reuse shared
helpers with the existing Jev integration. Authentication uses an Echo-origin
popup, a random state/verifier, an expiry, an exact opener check and a separate
nonce for returning the key from the Echo popup to the Echo review page.
After cap validation it may pass to the trusted extension vault. It never
passes to the article page.
Existing capped keys can also be pasted; they must pass the same rules.

The hosted page holds the key in memory. The extension remembers it in trusted-
context session storage by default, or local storage with explicit opt-in (see
Remembered connection below). Forget connection cancels work and removes stored
copies. A newly issued OpenRouter key may not be recognized immediately; the
user can reconnect/recheck explicitly. Model calls wait for successful cap validation.

No model call is automatically retried. A pending-call checkpoint is written
before a billable request, and the response receipt is saved before applying
its result. Reopening can consume that receipt without another charge.
Uncertain or invalid calls require explicit acknowledgement before a possibly
charged retry. Reported usage preserves null for unavailable values.

IndexedDB stores private runs on the Echo web origin, possibly in an
extension-partitioned storage area. Web Locks prevent simultaneous operation on
one run within that storage partition. The extension service worker does no
evaluation work. Closing the review interrupts execution; it does not run as an
unattended background job. Accepted decisions are saved. An uncertain public
publication is not replayed automatically. Delete removes the private run; it
cannot retract an immutable public schema or erase provider-side processing.

## Verification

```
npm test
npm run test:extension
npm run build:extension
npm run test:extension:browser
```

The browser acceptance test uses a real unpacked extension and an Echo-origin
iframe with fixed evidence and mocked OpenRouter, so it makes no paid calls
and no public publication. Unit tests compare browser incremental graph results
with the shared full compiler and cover qualification, exact quotations,
focal-paper exclusion, coverage, split-required failure, unknown/duplicate DOI
stops, durable billing receipts, uncertainty and minimal permissions.

Before general release, deploy and verify the actual hosted pages, perform
live OpenRouter login/key recognition and one supported paper evaluation, check
real Turnstile/publication in both tab and embedded modes, and measure cold/warm
data loading and reported cost/cache usage. Mocked acceptance cannot establish
those live-service results.

## Capture regression verification (0.1.1)

Extraction was checked against downloaded HTML from PMC2796879: title and DOI
`10.1093/gerona/glp099`, a 1,796-character abstract, and 23,074 characters of
article text were captured with full coverage. This verifies extraction, not a
live model evaluation. Tests cover toolbar-handler handoff with mocked Chrome
APIs, missing-section coverage, automatic form population and snapshot saving,
and a mocked complete review. The actual installed toolbar click could not be
verified because Computer Use permission was unavailable.

## Pipeline contract and claim-only flow (0.2.0)

`site/paper_pipeline_contract.mjs` is generated from the actual
`harvest_abstracts` runner and Pydantic definitions by
`scripts/sync_paper_pipeline.py`. It contains the exact v4 extraction prompt,
`DagConceptExtraction.model_json_schema(by_alias=True)`, split-classification
prompt, model/reasoning settings, upstream revision and source hashes.
Regenerate with the harvest classify virtualenv Python; pass `--check` to
verify byte-for-byte parity without writing. The pipeline stage is
`analysis/openai_luna_dag_20.py --concept-uoa-only`, invoked by
`analysis/run_claim_pipeline.sh`. Its `prompt_human` template is reproduced
exactly, including title markup removal. An additional safety instruction
marks article content as untrusted data. OpenRouter carries the same model
(`openai/gpt-6-luna`), with low extraction/setup reasoning and none for split
classification; no Flex tier or fallback model is requested. This is browser
execution of the shared extraction contract, not a remote Python pipeline job.

Raw variable/link output is saved unchanged. Graph references, uniqueness and
types are validated, and malformed receipts require explicit retry. Displayed
claims come from pipeline links rather than a separate prose-claim extractor.
Only present, single-exposure, person-level observational claims are selectable
for this preview's review protocol. The full article still verifies the chosen
claim; a pipeline extraction label alone does not establish eligibility.

## Remembered connection

After cap validation, the hosted page passes its key over the exact-origin,
exact-source, nonce-authenticated bridge to the extension vault. The vault
restricts both storage areas to `TRUSTED_CONTEXTS` before reading or writing.
Default `chrome.storage.session` survives panel and worker recreation without
writing a persistent secret to disk. Optional “Also remember after Chrome
restarts” stores the key in `chrome.storage.local`, never sync or web-origin
storage. This local option is unencrypted; browser-profile compromise can
recover the key. It is explicitly opt-in. The UI describes the tradeoff.

The hosted page receives the remembered key only in memory and rechecks its
cap on reconnection and before paid requests. Keys are excluded from paper
checkpoints, exports, captures and publication payloads. Forget connection
removes session and local copies and clears connected review windows. It does
not revoke the credential at OpenRouter; users can revoke it there separately.
Normal panel reload no longer requires another OAuth exchange.

Acceptance tests use mocked paid responses to check pipeline extraction, no
automatic claim selection, a claim click running the remaining review, session
restoration without another OAuth exchange, opt-in persistence and forgetting.
A paid end-to-end real-paper review remains unverified.
