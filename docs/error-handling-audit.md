# Error handling and recovery audit

Read-only review of `staging` at `ffe00d3`, by code reading only. Nothing here was reproduced in a browser, so each
finding says how it was derived. Complements `state-machine-audit.md`, which already fixed several save/startup cases.

## Status
Findings 1–4 are fixed on this branch (render guard and global error notice, stale-graph notice, state-based Retry,
storage-blocked message). Findings 5 and 6 remain open. The global notice was checked in a browser; the render guard has a
unit test; Retry, storage-blocked and stale-graph states were verified by code reading and the test suite only.

## Findings

### 1. No error boundary: one throwing renderer stops the rest (medium)
`renderAll` in `site/dag_builder.js` runs `renderCoordinator.renderAll()`, then `taskViews.render()`, then
`persistentViewer.viewerChanged()` with no `try/catch`, and `render_coordinator.mjs` has none either. A throw in any
earlier renderer skips the later panels and the URL/session save, and surfaces only in the console. The only
`init().catch` page covers startup, not later event handlers. There is no `error` or `unhandledrejection` listener
anywhere in `site/`.
Fix: wrap each render stage so a failure marks that panel as broken with a Retry, and add a global listener that shows a
non-blocking "something went wrong" notice and preserves the save state.

### 2. A failed draft-link application is silent and leaves a wrong graph (medium)
`project_bootstrap.mjs` (`applyDraftEdges` catch) sets `compiledDagValid = false` and only `console.warn`s. The user keeps
seeing the published graph's edges under their draft's group names, with no notice. A later edit recomputes, so it
self-heals only after the user changes something. The same pattern is at `dag_builder.js:1101` for the incremental
update (that path recovers on the next edit but is also unannounced).
Fix: set a visible "Graph links may be out of date. Recalculate" banner when `compiledDagValid` goes false after load.

### 3. Save failures reported through a single overwritable text line (low-medium)
Failures from undo, redo, history jump, status changes, exclusions and restores all end in `console.error`
(`dag_builder.js:244, 413, 418, 444, 605, 855, 1042, 1659, 1759, 1776`). The user-visible signal is only
`localSaveStatus` text, and the Retry button is derived by string-matching `message.startsWith("Not saved")`
(`dag_builder.js:1297`). Any later status write (for example "Previous view not saved", `notifyBriefly`) that replaces the
text also hides Retry while `unsavedSchema` is still true, so the app is unsaved with no control to recover.
`beforeunload` still protects the page, but nothing visible says why.
Fix: derive Retry visibility from `persistentViewer.saving`/a failed flag, not from message text.

### 4. IndexedDB unavailable means no saving and no stated way out (medium)
`openLocalDatabase` rejects with "IndexedDB is unavailable" (private windows, blocked storage). Every commit then fails
and Retry fails the same way, and Save independent copy is only offered for revision conflicts. The error text does not
point to export, which is the only way to keep work.
Fix: on this specific error, say so once, stop offering Retry, and show Export draft.

### 5. Offline/online transitions are not handled (low-medium)
No `online`/`offline` listeners or `navigator.onLine` use. Published-file fetches retry about 4 seconds in total
(`fetchPublishedFile`, 5 attempts, 250 ms doubling), then fail. The pieces that fail are mostly recoverable (edge
evidence has Retry; startup has Try again), but lazy variable metadata (`dag_builder.js:1216`) and sparse-link evidence
(`:1514`) only `console.warn`/`error`, and nothing retries when the connection returns.
Fix: a single "You are offline" indicator plus re-run of failed lazy loads on `online`.

### 6. Silent fallbacks in exports (low)
`dag_export_controller.mjs:67, 118, 181` swallow errors by design (Crossref, variable labels, worker). Bibliography
entries can silently degrade to DOI-only and labels to group labels, with no note in the export itself.
Fix: append a "N entries could not be enriched" line to the export or its status.

## Checked and sound
- Local commits are serialised; revision conflicts hide Retry and offer an independent copy; storage timeouts abort the
  transaction rather than hanging (`local_schema_store.mjs`).
- `beforeunload` guards a pending or failed schema write and unsaved definitions.
- Publishing is guarded by `busy`; uploads are create-only and `resume` handles a 409 `exists`/`publication_exists`, so a
  retry after an interrupted upload does not duplicate files (`cloudflare_api.mjs`). A changed working copy during
  preparation aborts rather than publishing mixed state.
- A failed startup shows Try again and Start new view; failed edge evidence has a Retry; OpenRouter requests use
  `AbortController`.

## Not examined
Behaviour in a real browser, interrupted R2 uploads against a live Worker, and crash recovery from a killed tab mid
IndexedDB write.
