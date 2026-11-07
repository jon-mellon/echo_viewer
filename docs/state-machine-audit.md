# State machine audit

The viewer has no state-machine library. Its state machines are spread across booleans, nullable objects, promises and
URL parameters. This lists them, the states they can reach, the combinations that should be impossible, and what
happened when unusual event orders were tried against them.

How this was checked: the code was read for each machine, a randomised sequence test drove `persistent_viewer.mjs` with
a controllable store (400 sequences of 24 events: edit, begin/finish/discard editor, commit, copy, URL sync, settle ok,
settle out of order, fail, other-tab write), a round-trip test compared `buildPermalink` and `applyPermalink` over 1,152
view combinations, and `tests/state_machines.spec.cjs` replays the browser scenarios below. Everything marked **verified**
was reproduced in Chromium.

## 1. The machines

| Machine | Where | State variables | States |
| --- | --- | --- | --- |
| Local persistence | `persistent_viewer.mjs` | `ready`, `editorBaseline`, `commitPending`, `unsavedSchema`, `localRecord.revision`, `committedSchema` | not started; clean (published); clean (local record); editing; saving; save failed; revision conflict |
| Publication | `dag_publication.mjs` | `busy`, `statusRevision`, `hasPublishableChanges`, `canPublish()` | idle with no changes; idle with changes; comparing; confirming; preparing; uploading; failed |
| Startup | `project_bootstrap.mjs`, `dag_builder.js` | `publishedSchemaHydrating`, `publishedSchemaHydrated`, `publishedSchemaLoadFailed`, `compiledDagUpdating`, `variableSearchStatus` | loading; hydrating; ready; failed; error page |
| View ⇄ URL | `dag_permalink.mjs` | task, `workflowMode`, anchors, diagnostic view, selection | any view the URL can describe |
| Setup phase | `dag_workflow.mjs` | `phase`, `changingAnchorSide` | select_dv, define_dv, select_iv, define_iv, select_instrument, build, schema_choice |
| Definition draft | `definition_workflow_controller.mjs` | `definitionDraft.step` | describe, sources, partition, … |
| Edge evidence | `dag_builder.js` | `selectedEdgeId`, `pendingEdgeEvidence` | none selected; loading; shown; failed |
| Variable review | `variable_review_controller.mjs` | `pending`, dialog | closed; asking for a reason |
| Undo history | `project_history.mjs` | `undoPointer`, `undoHistory` | at tip; behind tip |
| OpenRouter sign-in | `definition_jev_assist.mjs` | `OAUTH_*` keys, `key`, `keyCheck`, `newKeyWaiting` | disconnected; redirected; exchanging; checking key; retrying; connected; invalid |
| Password gate | `password_gate.js` | `sessionStorage` flag | locked; unlocked (a notice, not security) |

The app never calls `pushState` and has no `popstate` handler. Only `replaceState` is used, so in-app navigation adds no
history entries. The browser Back button leaves the app, and a view is rebuilt from its URL on every load.

## 2. Contradictory or invalid states found

### Confirmed

**A. Publishing stays disabled after a failed save is retried successfully.** (verified, `state_machines.spec.cjs`)
Save fails, so `unsavedSchema` is true and the Publish control is disabled with "unavailable while … a variable edit is
unsaved". Clicking Retry save succeeds, the status clears and the Retry button hides, yet Publish stays disabled for at
least ten seconds. It recovers only when some unrelated render refreshes it. Cause: the Retry handler calls
`commitDecision()` without `publicationController.workingCopyChanged()`; the other save paths do call it. Four more
`commitDecision()` callers in `dag_builder.js` (undo, redo, history jump, restore variable) have the same shape and may leave the
publication badge and Publish control stale after a schema change; those were read but not exercised.

**B. A revision conflict shows a Retry button that can never succeed.** (verified)
When another tab has saved the same draft, the status reads "Not saved — Schema revision changed in another tab" with
both Retry save and Save independent copy. Retry reuses the stale revision, so it fails every time (two clicks
reproduced it). Save independent copy does recover: a new draft id, saving works, publishing is enabled.

**C. A failed startup leaves an error page with no controls.** (verified)
`dag_builder.js` replaces the whole body on any startup error. Only a missing local schema gets a "Start new view"
link. A network failure produces "Echo could not open this view / Failed to fetch" with no link or button; a manual
reload recovers once the network is back.

**D. Unknown task, or an explore focus that no longer exists, blames the wrong thing.** (verified)
`?task=nonsense` and `?task=causes&causes_of=missing` both show "Permalink cause or outcome is absent from the
referenced schema." and nothing else (same dead end as C).

**E. A save in flight does not block publishing during "Save independent copy".** (found by the sequence test)
`saveIndependentCopy` does not set `commitPending`, so `canPublish` is true while that write is outstanding. Low impact:
publishing reads the in-memory schema, and the window is one IndexedDB write.

### Lower severity

- **Invalid values are accepted from the URL and re-emitted.** `mode=bogus` becomes `workflowMode: "bogus"` (the page
  renders like the dag view) and is written back into every later URL. `selected_edge` and `selected_variable` are not
  checked against the graph; a stale id is stored and re-emitted with no visible error.
- **An edit made just before a reload can be lost.** The write is queued in a microtask and is asynchronous. A reload
  that lands before it completes loses the edit with no warning (reproduced by stalling the write 400 ms). There is no
  `beforeunload` guard while `commitPending` is set.

## 3. Checked and sound

- Rapid re-selection of edges while the first one's evidence is slow ends on the last edge, with no stuck spinner.
- Double-clicking Confirm exclusion records one decision; fast exclude/restore toggles leave the stored draft equal to memory.
- Two tabs on one draft: the stale tab is refused, keeps its in-memory edit, and the independent-copy path works.
- `commitCurrentSchema` serialises overlapping commits; an out-of-order settle never leaves the saved record behind the schema (400 random sequences).
- A late old write cannot replace a newer URL for a session (sequence numbers, existing test).
- A replayed or mismatched OAuth callback makes no request to the provider and strips `code` and `state` from the URL.
- An instrument with the confounder or collider view: `applyPermalink` would restore the exclusion view instead, but the UI cannot produce that combination (the toggles are hidden), so it is not reachable.

## 4. Not exercised

Real OpenRouter key exchange and retry timing; publishing to R2 (the fake service was not driven with interrupted uploads);
the setup phase and definition draft under browser refresh at every step; mobile panel switching; IndexedDB blocked by a
second tab at open time.
