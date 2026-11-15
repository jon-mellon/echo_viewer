# Echo paper-evaluation Chrome extension

## Objective

### Architecture update (2026-11-15)

The requested first version uses an **Echo-hosted review page**, embedded in a
cross-origin iframe in the extension side panel, with an Echo-tab fallback.
The extension packages only its shell and user-invoked article capture. Echo's
page owns the review, OpenRouter connection, browser query engine and publication.
Requests to the data host and publishing API therefore originate from
`https://www.jonathanmellon.com` on staging, which is already permitted.
Production builds omit the preview, and runtime entry points reject the production
domain even if the feature branch is merged into `main`. This supersedes
the requirements below to package the evaluation JavaScript/WASM in the extension
and adapt OAuth to an extension-origin redirect. No remote script is imported
into the privileged extension context; the hosted page receives no Chrome APIs
or ability to request arbitrary captures. See [implementation and installation](echo-paper-extension.md).

Provide a Chrome extension that evaluates a claim from the academic paper currently open in the browser using Echo's existing evidence, graph operations and agent evaluation protocol. The user connects their own OpenRouter key, sees claims extracted from the abstract, chooses one, and receives a private, inspectable evaluation with an optional Echo publication.

Run the evaluation in the browser. Reuse Echo's static-hosted assets, client-side computation, existing OpenRouter connection and existing publication service. Do not introduce a hosted evaluation service, remote MCP endpoint, native companion, local Node/DuckDB installation or Flex API calls.

## Sources and existing implementation

- `site/dag_data_source.mjs`, `site/dag_data_config.mjs`, `site/grouping_schema_loader.mjs`, and `site/published_schema_loader.mjs`: load published schemas, compiled DAGs and evidence; use browser DuckDB-WASM and static-hosted assets.
- `site/dag_project.mjs`, `site/compiled_dag.mjs`, `site/dag_view.mjs`, `site/study_graph.mjs`, `site/dag_candidates.mjs`, `site/confounder_status.mjs`, and related modules: UI project operations, graph and diagnostic behavior.
- `agent/tools.mjs`, `agent/session.mjs`, and `agent/local_data.mjs`: MCP tool contracts and the existing Node adaptation of the same Echo operations. Node's stdio, filesystem, child process and environment interfaces are not browser APIs.
- `site/definition_jev_assist.mjs` and `site/definition_jev_core.mjs`: existing OpenRouter PKCE, key checking, request helpers and Jev split behavior. Extract shared connection functionality rather than creating a second independent flow.
- `harvest_abstracts/analysis/echo_agent_demo/agent-evaluation-process.qmd`, `reviewer_protocol.md`, `review_contract.mjs`, `workflow.mjs`, `setup_loop.py`, `finding_judge.py`, `api_review.py`, and `run_agent.py`: reference evaluation protocol, contracts and all-API orchestration. Port the behavior required for a single user-selected paper into this repository; the extension must not require the harvest repository at runtime.

## User flow

1. On a paper page, the user opens Echo's extension side panel and requests an evaluation. Capture the active tab only after the user invokes the extension.
2. Extract and display title, DOI, URL, abstract and available article text. Identify the source and whether the full article or only a partial page was captured. Allow correction and paste fallback. Do not present an unavailable abstract as if it were extracted.
3. Once OpenRouter is connected, extract all distinct substantive claims stated in the abstract into a structured list. Associate each claim with exact source sentence(s), preserve qualifications and direction, and avoid inventing findings. Label extraction as potentially incomplete; allow the user to edit or add a claim. No evaluation starts until a claim is selected.
4. Verify the selected claim against the captured full text. Identify the focal finding, evidence location, exposure X, outcome Y, population, design, treatment assignment and adjustment set. Explicitly say when a required field is unavailable. If the text contradicts the claim or is insufficient for the protocol, stop and explain what is missing; allow the user to supply text and retry.
5. State whether the claim meets the implemented evaluation protocol before running. The reference all-API demonstration targets person-level, nonrandomized observational causal estimates with implied selection on observables. Do not silently apply that protocol to unsupported designs, noncausal claims or other units of analysis. Claim extraction remains available for all abstract claims.
6. Run the Echo evaluation and show the current phase, meaningful progress, spend and cancellation control. Keep the review private by default. Present the result, supporting findings, X/Y definitions, confounder statuses, uncertainty and limitations; make publication a separate explicit action using Echo's existing flow.

## Components

### Extension shell and capture

Use a Manifest V3 extension with an action and side panel. Use `activeTab` and `scripting` for user-initiated capture and limit persistent host access to the static data and API origins actually required. Capture article text through a content script; remove page navigation and boilerplate while preserving paragraph and section boundaries. Prefer structured citation metadata and article/abstract markup, then documented publisher-independent fallbacks. Provide selected-text or paste fallback. Treat browser PDF viewers, restricted Chrome pages, scanned documents and pages with inaccessible or paywalled text as explicit unsupported/partial cases; do not imply access to content Chrome did not expose.

Return a `PaperCapture` containing source URL, title, DOI if found, abstract, article text, extraction method, coverage (`full`, `partial`, `abstract_only`, `unknown`), and capture timestamp. Validate fields, normalize DOI where possible, and display them for correction. Do not assume a DOI or the article exists in Echo. Bind a run to a hash of the confirmed capture so navigation or editing cannot silently change the evidence mid-run.

Bundle extension JavaScript, workers and WASM locally in the extension package in accordance with Chrome extension requirements. Verify that DuckDB-WASM, its worker, relevant extensions, fetch/CORS behavior and existing asset URLs work under the extension origin and its CSP; adapt the packaging or asset retrieval where needed. The page itself must not receive the OpenRouter key or privileged extension objects.

### Browser Echo tool adapter

Separate tool contracts and domain operations from MCP transport and Node-specific storage. Implement browser-backed operations for the subset actually called by the evaluation: session start/resume/status; group and variable search/details; findings and neighbor retrieval; group creation, membership and split operations; published split discovery/application; anchor selection; graph and candidate diagnostics; finding decisions; confounder statuses; Jev estimate/test/full/override/apply; diff and readiness. Reuse the same UI operations and validations rather than writing another graph engine. Expose names, input schemas, error semantics and results compatible with the current agent tools where practicable; the in-browser agent can dispatch tools directly without stdio or a network MCP server.

Pin publication ID, schema content hash, physical evidence snapshot ID and relevant asset identities at run start. Verify schema/snapshot binding with Echo's existing logic. Use browser retrieval and incremental graph operations when correct; do not assume the MCP's full raw-link scan or its exact result ordering is automatically equivalent. Include any required parity adapters. Missing data or a mismatched snapshot must stop the affected step with an actionable error, never silently substitute a newer snapshot.

Keep the mutable working schema and finding-level decisions separate per run. Do not write to the published schema or alter the snapshot during review. Preserve the existing finding-level, rather than article-wide, decision granularity and private open explanations. Existing publication remains an explicit final user operation.

### Evaluation orchestration

Port the all-API workflow's substantive behavior and structured schemas into browser-compatible modules. The browser user selects the paper and claim, so remove candidate sampling, queue ledger, local full-text paths and demonstration-specific sampling provenance. Replace those checks with validated capture, selected-claim and source provenance, while preserving qualification, focal-variable safeguards and coverage validation. Retain uncertainty when the focal paper's variables are not in the snapshot; never manufacture a matching occurrence.

1. Qualify the selected claim using the actual captured paper, preserving the distinction between randomized and observational components.
2. Search suitable groups for X and Y; reuse existing groups or approved published splits when appropriate. Inspect actor/unit relationships and preserve substantive boundaries. When creating a split, retain the reference workflow's test, revision, classification, override and focal-variable placement safeguards. Use the existing Jev integration when that classifier is selected.
3. Set anchors and derive the distance-one confounder graph. Enumerate underlying raw findings on both K→X and K→Y legs, including endpoint metadata.
4. Judge findings with reasons and existing exclusion categories. The focal paper is not independent supporting evidence. Follow the report's per-link order and stop only when all applicable evidence is reviewed or five undeniable relevant findings from distinct independent papers are retained. Preserve applicable early termination when a leg is cleared and the other is no longer needed.
5. Assess whether K's meaning differs systematically across the two legs enough to invalidate a common-confounder inference. If a justified split is needed, record its rationale, apply it, rebuild the graph and review affected evidence again. Bound repetitions according to the reference workflow; fail visibly if the limit is reached.
6. Build the paper's control inventory and assign each candidate the reference workflow's six accepted statuses with an explanation. Credit defensible controls, proxies and fixed effects according to the reference protocol and record limitations. Preserve enabled graph-based checks and route-rejection requirements where applicable; distinguish those from prompt-only judgments.
7. Merge parallel review fragments deterministically, validate coverage and the working schema, and produce a private outcome with claim provenance, evidence, reasons, split and confounder decisions, limitations, pinned data IDs, model and usage. A failed validation cannot be labeled complete.

Preserve published-split lookup, split quality rules and independent evidence handling from the reference protocol. Review snapshot-scoped finding-history, miscoding and split-library registries explicitly: design local per-user equivalents or record when unavailable; do not silently transfer another user's private judgments, depend on machine-global files, or claim exact parity when history is absent.

### OpenRouter

Reuse Echo's existing PKCE connection and its key validation, spending-cap checks, in-memory key handling and Jev helpers. Adapt the callback for the extension environment and verify it end to end; do not assume a browser-page redirect works unchanged in an extension. Preserve existing key rules unless intentionally changed and tested. Never put a key in a content script, URL, result artifact, checkpoint or log. Disconnect clears it; after a restart that loses the key, resume only after reconnecting.

Add a general structured-output/tool-calling client using the same connected key for claim extraction, qualification, setup, classification and review. Choose OpenRouter models that actually support the required tools and schemas; validate response shape and errors. Existing demonstration calls to OpenAI and provider-specific cache breakpoints are not directly portable: translate requests and cache controls for the selected OpenRouter model/provider. Do not send `flex` or otherwise opt into a Flex tier.

Use stable shared prefixes for instructions, schemas, tool definitions and reusable paper context; append task-specific input later. Use a stable per-run session identifier for provider stickiness where supported, and explicit cache controls only for providers that support or require them. Where possible warm a reusable prefix before parallel review. A cache hit, discount or retained cache during user selection is not guaranteed. Track reported input, output, cached-read and cache-write tokens and actual cost where returned; distinguish unavailable usage from zero. Surface model, cost and cache metrics in the result. Handle rate limits, credit exhaustion, timeouts, invalid structured results and provider fallback without silently changing the review or duplicating charged requests.

## Lifecycle and security

Persist per-run checkpoints after durable state transitions and accepted tool decisions in extension storage or IndexedDB; include versioned state, evidence identities, capture hash, accepted outputs and review progress, but no key. Support resume, cancellation and deletion. Acknowledge that an extension service worker can be suspended and an extension page can close: do not rely on in-memory timers or promise completion. On interruption mark in-flight calls as uncertain; do not automatically replay a potentially billable model call or public publication. Ask the user to retry uncertain work with clear status. Avoid duplicate application of decisions through stable operation IDs or equivalent idempotency checks.

Treat paper text, external metadata, evidence snippets and model output as untrusted data, never instructions to the agent. Validate tool arguments and structured results, limit allowed tools to the workflow, and do not give the model an autonomous publish operation. Keep captured paper and private rationale local to the extension except for the text sent to OpenRouter and any explicitly requested Echo publication. Make data transmission and deletion clear in the UI.

## Publication and output

The default deliverable is a private review with an exportable structured outcome. The user may explicitly choose to publish after seeing the preview. Use Echo's existing owner-token, readiness and publication flow and public projection; do not bypass its validation or leak private open-text reasoning into a public artifact. Make clear which material becomes public. Preserve the existing single-publication/uncertain-publication safeguards and return the Echo permalink on success.

## Verification and acceptance

- Extension capture works on representative structured HTML article pages, abstract-only pages and fallback input; page navigation does not replace an active run's paper.
- Claim extraction returns source-grounded, editable choices. Unsupported and insufficient-text selections cannot be represented as completed evaluations.
- On fixed schema/snapshot fixtures, compare browser and MCP tool outputs and decision effects, including search, raw findings, graph/confounder IDs, splits, review statuses and readiness. Document intentional differences in retrieval/order and test that they do not change evaluation semantics.
- Compare browser orchestration against reference workflow fixtures: focal paper exclusion, distinct-DOI stopping, short-leg handling, split requeue, exact allowed statuses, route checks, coverage and outcome validation. Exercise absent focal variables and unavailable history.
- Test OpenRouter PKCE and cap checks in an actual extension context; model structured output, tool calls, no-Flex requests, cache configuration, observed cache usage, concurrency, budget exhaustion and error handling. Confirm no key appears in page context, storage, logs or exports.
- Test cold and warm static asset retrieval, snapshot mismatch, offline/reconnect, large evidence sets, Chrome extension CSP/WASM loading, worker interruption, cancellation and safe resume. Verify no duplicate publication or automatic retry of uncertain billed work.
- Confirm results remain private until explicit publication, and that publishing uses the existing public projection and returns a valid Echo link.

## Delivery sequence

1. Factor shared browser-safe Echo operations and the OpenRouter connection; add tool parity fixtures.
2. Build extension shell, capture, connection and claim-selection flow.
3. Port single-paper orchestration and review contracts, then connect the browser tool adapter.
4. Add checkpoints, result UI, usage reporting and explicit publication.
5. Run end-to-end parity and failure tests on representative papers. Measure stage latency and actual standard-tier cost/cache behavior rather than assuming the report's Flex results apply.
