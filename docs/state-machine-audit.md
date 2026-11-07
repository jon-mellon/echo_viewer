# State machine audit

The viewer has no state-machine library. Its state machines are spread across booleans, nullable objects, promises and
URL parameters. This lists them, the states they can reach, the combinations that should be impossible, and what
happened when unusual event orders were tried against them.

How this was checked: the code was read for each machine, a randomised sequence test drove `persistent_viewer.mjs` with
a controllable store (400 sequences of 24 events: edit, begin/finish/discard editor, commit, copy, URL sync, settle ok,
settle out of order, fail, other-tab write), a round-trip test compared `buildPermalink` and `applyPermalink` over 1,152
view combinations, and `tests/state_machines.spec.cjs` replays the browser scenarios below and now guards each fix. Everything marked
**verified** was reproduced in Chromium before it was fixed.

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

## 2. Contradictory or invalid states found, and how each was fixed

**A. Publishing stayed disabled after a failed save was retried successfully.** (verified)
Retry save succeeded but nothing told the Publish control, so it kept saying "unsaved" until an unrelated render. The
save machine now reports every move (saving, saved, failed, editor opened or closed) through `onSaveStateChange`, which
refreshes the publication controls (`canPublishChanged`). This also covers undo, redo, history jump and restore, which
commit without refreshing the controls themselves.

**B. A revision conflict showed a Retry button that could never succeed.** (verified)
Retry reused the stale revision. Retry is now hidden for that error; Save independent copy is the exit.

**C. A failed startup left an error page with no controls.** (verified)
Every startup error now shows Try again and Start new view.

**D. An unknown task, or an explore focus that no longer exists, blamed the cause and outcome.** (verified)
The messages now say "This link's focus variable is not in the referenced schema." and "This link names a task that
Echo does not recognise."

**E. Publishing was not blocked during Save independent copy.** (found by a random-sequence test)
`saveIndependentCopy` now occupies the same in-flight slot as an ordinary commit, waits for any outstanding commit
first, and so blocks publishing until it finishes.

**Invalid workflow mode in the URL.** `mode=bogus` was stored and written into every later link. Only `setup`, `dag`
and `group_review` are accepted now; anything else opens the graph.

**An edit made just before a reload could be lost.** The page now asks before unloading while a schema write is
outstanding or has failed, using the same `beforeunload` guard as unsaved variable definitions.

**Not changed:** `selected_edge` and `selected_variable` from the URL are still not checked against the graph, because
the graph is not known when the link is applied. A stale id is stored and re-emitted without a visible error.

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
