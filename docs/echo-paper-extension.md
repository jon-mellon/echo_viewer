# Echo Paper Review 0.1

The implementation lives on `codex/echo-paper-extension-spec`. The extension is a
small Manifest V3 shell. Its side panel embeds `https://www.jonathanmellon.com/echo_viewer_staging/paper-review.html`.
The browser runs the review in that web page, using the existing static data and
publication service. There is no evaluation server or remote MCP endpoint.

## Build and install

### Test after merging to staging

Once the **Deploy Echo Staging** workflow and its GitHub Pages build succeed,
open <https://www.jonathanmellon.com/echo_viewer_staging/extension.html>.
Download its ZIP, unzip it, and load the extracted folder using Chrome's
Developer mode **Load unpacked** control. The staging deployment builds this
package with `npm run build:extension:staging`, so its review frame opens the
staging page on the already allowed `www.jonathanmellon.com` origin.
It does not depend on a production deployment. You will need your own capped
OpenRouter key and a model supporting tools and structured output to try the
model steps. This remains a preview whose live real-paper evaluation is unverified.

### Local staging package

1. Run `ECHO_PAPER_REVIEW_ENABLED=1 npm run build:site` for a staging or local
   development build. The new `paper-review.html`, `paper-auth.html` and
   their modules must be deployed together. **They are not deployed by the extension build.**
2. Run `npm run build:extension:staging` (the default extension build also targets staging).
3. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
   and select `dist/extension`.
4. Open an HTML paper and click the Echo toolbar action. In the side panel choose
   **Capture current paper**. Correct the text and coverage before confirming it.
5. Connect a capped OpenRouter key, select a model ID that advertises tools and
   structured output, extract/edit/select a claim, qualify it, and start the review.

The extension has only `activeTab`, `scripting` and `sidePanel` permissions. It
has no persistent article-host access, API-host access, background capture,
externally-connectable command interface, or key storage. Clicking Capture is
required to read a page. Restricted Chrome pages and inaccessible PDFs need
paste fallback. Structured article captures are conservatively marked partial;
only the user can confirm that full text has been supplied.

## Production release gate

Merging this code into `main` does not enable the preview on production.
`build:site` excludes the install page, review/auth pages, all `paper_*` modules,
review CSS and any extension ZIP by default. Only the staging workflow sets
`ECHO_PAPER_REVIEW_ENABLED=1`; the production workflow does not package an extension.
The browser entry point and OAuth callback also reject the production domain,
including if raw source files are served accidentally. The only web deployment
allowed at runtime is the exact staging origin/path; localhost is allowed for
development. Extension builds target staging by default and reject an explicit
production target. Changing a URL or query parameter cannot enable production.

This is a release gate, not invite-only authentication. The staging website and
its download are public. Named-testers-only access would require authentication
at the staging host. Enabling a future production release requires deliberately
changing the runtime host rule as well as the build/deployment configuration.

## Why requests go through the Echo origin

The iframe is a real Echo web document, not a reverse proxy. Its fetches and
DuckDB worker requests have the Echo origin/referrer and use the existing
Cloudflare allowlists. Its scripts and WASM execute inside Echo's web context;
the privileged extension shell only uses packaged JavaScript. The frame has a
sandbox with scripts, same-origin web behavior, forms, downloads and escaping
popups enabled. It cannot access extension APIs or the parent DOM. No incoming
message can ask the shell to fetch, run scripts, read tabs or publish.

Capture messages require the exact frame/opener, expected origin and a random
per-panel nonce. The readiness message contains only the nonce. Article text
is sent using an exact Echo target origin. The receiver validates and bounds the
capture. New captures cannot replace an existing confirmed run.

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

- Editable source-grounded abstract claims and selected-claim qualification.
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
nonce for returning the transient key. The key is passed only between the Echo
popup and Echo review page. It never goes through the extension or article.
Existing capped keys can also be pasted; they must pass the same rules.

The key remains in memory. Disconnect cancels work and clears it; a reload or
closed page requires reconnecting. A newly issued OpenRouter key may not be
recognized immediately; the user can reconnect/recheck explicitly. No model
call is automatically retried. A pending-call checkpoint is written before a
billable request, and the returned response receipt is saved before applying
its result, so reopening can consume that receipt without another charge.
Uncertain calls require explicit acknowledgement before a possibly charged
retry. Reported token/cost/cache metrics preserve null for unavailable values.
Standard requests never set Flex; provider/model fallback is disabled, explicit
provider cache controls are omitted, and stable paper/instruction prefixes can
benefit from supported automatic caching without promising a discount.

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
