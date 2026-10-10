# Echo — Persistent URLs and Local Schemas

Status: Implementation specification, v4 (2026-10-10)

Architecture: Static SPA, existing permalink reconstruction, IndexedDB. No backend changes are required for local persistence.

## 1. Product model

Echo continuously writes the current reconstructible viewer state into the address bar using its existing permalink format and serializer. The URL refers to either an immutable published schema or a mutable schema stored in this browser's IndexedDB. Opening a URL runs the existing reconstruction pipeline.

Opening the bare root **always starts a fresh view**. A Previous Sessions button lists locally saved views and lets the user restore one deliberately. Each list entry has a local session ID and its latest URL, title, and timestamp. The URL remains the sole serialized viewer-state format. Session IDs organize the local list and do not alter portable permalink instructions. A local-schema URL works only where that schema exists.

The schema editor uses an isolated in-memory working copy. Done commits effective changes; Discard drops them. A refresh or crash during editing restores the last committed viewer and schema, with uncommitted edits lost.

Edge exclusion is a persistent schema-level decision. Its status and optional reason are saved in the local schema. The **public projection retains exclusion status but never contains the reason**. Publication remains explicit.

## 2. Scope

The implementation must preserve published permalink behavior, published data-version pinning, ordinary graph behavior, and one shared permalink parser/serializer/reconstruction pipeline. It must support URL updates during viewer interaction, committed local schema drafts, recovery from normal refresh and browser-process crashes, safe concurrent editing, export/import, and negligible interaction overhead. Because Echo is not live, migration or compatibility for pre-release URLs and local autosaves is not a release requirement.

The initial implementation does not include migration of Echo's current local-storage project autosaves, manual session naming or deletion, schema-edit history, cross-device sync, cloud backup of drafts, editor-state recovery, derived layout or DuckDB cache persistence, or fully offline use. The old autosave path must not remain authoritative or silently restore stale data after the new flow is installed.

## 3. Repository integration points

Before implementation, audit and extend these existing paths:

- `site/dag_permalink.mjs`: `permalinkInput`, `buildPermalink`, and `applyPermalink`.
- `site/project_bootstrap.mjs`, `site/dag_data_config.mjs`, `site/dag_data_source.mjs`, and `site/published_schema_loader.mjs`: startup, data pinning, schema resolution, and reconstruction.
- `site/dag_group_editor_controller.mjs`, `site/dag_event_controller.mjs`, `site/dag_project_controller.mjs`, and `site/render_coordinator.mjs`: editor mutations, Close behavior, and existing local-storage autosaves.
- `site/grouping_set_controller.mjs`, `site/grouping_schema_writer.mjs`, `site/grouping_schema_loader.mjs`, and `site/dag_publication.mjs`: canonical schema, hashing, and publication.
- `site/dag_link_aggregation.mjs` and `site/compiled_dag.mjs`: edge decisions and compiled public artifacts.

The current editor mutates `state.project` and rendering queues a local-storage project save. It therefore needs an actual working-copy boundary; changing the Close handler alone would not provide the specified crash behavior. The current compiled DAG can carry a full `user_decision` object, so reason redaction must cover compiled artifacts as well as schema files.

## 4. URL and reconstruction

Extend the existing schema reference without inventing a parallel URL format. Published `?schema=<published-id>` and `?schema_url=<...>` links keep their meaning within the new implementation. Add an unambiguous local reference, such as a dedicated `local_schema` parameter or a carefully validated namespaced value. No migration of pre-release links is required.

All viewer instructions continue to use the existing permalink serializer. Local URLs contain an opaque local schema ID, never complete schema data or private exclusion reasons. A local reference resolves to the **latest committed revision** of that ID, so its schema content is intentionally mutable. Published references remain immutable and independent of local storage.

On reconstruction, resolve the published data version, load the referenced published or local schema, normalize it with existing code, and apply the existing permalink instructions. Do not build a second graph reconstruction engine. If a local ID is missing or invalid, show an explicit error with Import Draft and Start New options; do not silently display another schema.

URL generation must not serialize a schema, read IndexedDB, reload data, run a DuckDB query, recompute layout, or reroute edges. It reads the active schema reference as a small identifier.

## 5. State ownership

| State | Durable representation |
| --- | --- |
| Viewer filters, anchors, mode, selections, configuration, and viewports within permalink scope | Existing URL instructions |
| Group definitions, assignments, rejected variables, and other canonical schema content | Published schema or committed local schema |
| Edge exclusion status and optional reason in an unpublished draft | Committed local schema |
| Edge exclusion status in a publication | Public schema/compiled DAG, with reason absent |
| Editor working changes and definition drafts | Memory only until committed |
| Undo/action/decision history | Memory only, unless a field is required for reconstructing behavior and is explicitly promoted into URL or schema state |
| Previous view list | IndexedDB records containing each view's latest URL string and display metadata |

An edge's effective exclusion must survive refresh. Store it with schema content, not as a new local-only viewer blob. Existing schema folder serialization supports top-level extras, but implementation must explicitly define, validate, load, hash, and apply the edge-decision field. Do not assume that adding an extra property automatically makes graph reconstruction honor it.

`link_decisions` is the likely source field. Define a stable, minimal stored shape keyed by edge ID: public status, plus a local-only optional reason. Preserve any additional field only if it is needed for reconstruction. Distinguish ordinary viewer settings from persistent schema decisions by behavior, not by the UI control's location.

## 6. Viewer URL updates and previous views

For reconstruction-relevant discrete viewer changes, regenerate the existing permalink promptly, coalescing changes in the same event-loop turn where practical, and call `history.replaceState()`. For continuous interactions such as pan/zoom, debounce at an initial 250–500 ms and force a final update at interaction end. Use `pushState()` only for deliberate navigation to another URL. Do not reconstruct the graph merely to update the URL.

After replacing the URL, asynchronously persist **that same URL string** to the current local session record in IndexedDB. Coalesce pending writes and use a monotonic sequence per session so an older completion cannot replace a newer URL. On visibility change, attempt a prompt flush. A failed write leaves the current URL and graph intact but shows that the Previous Sessions entry may be stale.

Opening `/` without reconstruction instructions always starts the normal default viewer and creates a fresh session identity. The address bar then fills with reconstruction instructions as the viewer becomes ready. Opening an explicit URL reconstructs that URL and starts an independent local list entry unless it was selected through Previous Sessions. Selecting a previous entry associates its ID with the restored view and updates that entry as the user works.

The address bar is the primary representation of the active viewer state. Browser restoration of a tab can therefore recover a newer viewer state than its Previous Sessions entry if an asynchronous save was interrupted.

## 7. Isolated schema editor and commits

Entering the editor clones the last committed schema-relevant state into an editor working copy. Editing does not mutate the committed project/schema, create a local ID, update the schema URL reference, or write a schema snapshot. Graph previews may use the working copy in memory. Existing per-render and per-input local-storage autosaves must be removed or separated from this editor flow.

Done performs semantic change detection, then validates the finalized schema using existing validation. If unchanged, it closes without a schema write or URL change. If changed, it creates a local ID when necessary or reuses the active local ID, writes one complete canonical local schema snapshot, increments its revision, and waits for transaction completion. The same IndexedDB transaction updates the current Previous Sessions entry with the committed URL. Only then does Echo update the address bar and show the committed viewer. Use strict transaction durability where supported, treating it as a hint rather than an absolute guarantee.

If the write fails, keep the working copy and editor open. Show Retry and Export Draft; never claim it was saved. Discard drops the working copy. Unrelated navigation while the editor is dirty offers Commit or Discard. Refresh or crash before transaction completion discards uncommitted edits and restores the previous committed viewer; after completion the new schema and recovery URL remain discoverable even if `replaceState()` did not run.

**Edge decisions are a defined exception to the editor-only commit boundary.** Excluding or restoring an edge outside the group editor commits a schema-level decision at the completion of that user action. If starting from a published schema, this creates a local draft ID. If already local, it replaces the same local schema record and increments its revision. Save the complete local schema and current session URL atomically before reporting the action as saved. On failure, keep the decision in memory with a visible unsaved state and offer Retry/Export Draft; do not make a URL falsely imply durable success. Variable reassignments inside the editor still cause no per-assignment writes.

## 8. IndexedDB records, failures, and conflicts

A local schema record contains an ID, format version, revision, complete committed schema including local edge decisions/reasons, optional base and last-published IDs/hashes, and creation/update timestamps. A new successful commit overwrites the current record; no unbounded snapshot history is retained. Request persistent origin storage where supported, without presenting it as a backup guarantee.

The database also holds Previous Sessions records. Each stores an ID, latest URL, title, and timestamps; it does not separately serialize viewer state. Schema commits update the schema and current session record in one transaction; ordinary URL changes update only the current session record. A sequence check prevents a pending older write for the same session from overwriting its newer URL. No URL is written to browser history until the required schema transaction has completed.

For concurrent tabs editing the same local schema, record the revision when work begins and compare it against the authoritative revision inside the write transaction. A changed revision blocks the stale commit. Offer Reload or Save as Independent Local Copy. BroadcastChannel or an ownership notice may improve UX, but the IndexedDB revision check is mandatory. A bookmarked or copied local URL can open the same mutable draft in another tab; it is not an independent copy.

Storage failure must not reset the viewer. Missing/corrupt schema records receive clear errors. Browser storage deletion, private browsing policies, and device loss remain outside the recovery guarantee.

## 9. Publication and reason privacy

Publishing is explicit. The local working copy and its URL remain after publication; save the last published ID/hash on the local record and generate a separate portable published permalink using the same viewer instructions. Further local edits keep the stable local ID and do not change an earlier publication.

Create a **public projection** of the committed local schema before canonical hashing, file generation, graph compilation, or upload. The projection preserves the edge exclusion status and removes private reason fields. An empty reason is acceptable, but omission is preferred to avoid accidental display or ambiguous semantics. Apply a strict allowlist for public edge-decision fields rather than deleting only one known key. The public projection is what the published hash describes. Local reasons must not influence the published hash.

Sanitize every public artifact, including `groups.tsv` metadata, manifest extras, `compiled/dag.json` edge `user_decision` objects, exports that are presented as public, and any fallback compilation path. In particular, a cached/precompiled DAG must be checked or rebuilt from the public projection before upload; publishing must not trust `getCompiledDag()` merely because it is valid for local rendering. Test the final bytes destined for storage for private reasons and reason-field names. A public URL must never contain reasons.

Before releasing this feature, audit existing published compiled graphs for `exclude_reason` or other private reason values. If any are present, define and execute remediation for those immutable artifacts/publications separately. Do not assume that changing future publishing removes already uploaded data.

The Share control must not present a local URL as portable. A copied address-bar local URL should be visibly identified as browser-local. A published permalink reconstructs the published exclusion statuses without needing IndexedDB or exposing local reasons.

## 10. Export and import

Export a complete committed local draft with its schema, local-only reasons, URL instructions, data-version reference, provenance, and format version. If a save fails while editing, Export Draft includes the in-memory working copy. Because reasons may be sensitive, label a full local export accordingly; a separate public export, if offered, must use the public projection.

Import validates and migrates supported formats, creates a new independent local schema ID, saves the schema, rewrites its URL through the existing serializer, and reconstructs through the normal pathway. Import never overwrites an existing local ID by default. No migration from the current pre-release local-storage autosave is required.

## 11. Performance

Benchmark gathering instructions, encoding, URL construction, `replaceState()`, and IndexedDB URL mirroring separately. Initial targets are under 5 ms typical for URL generation and under 2 ms typical for URL replacement, with no per-frame serialization. Use representative graphs of 5/12, 20/100, and roughly 104/1,200–1,400 nodes/edges, plus schemas with many assignments, on desktop and mobile-class hardware. Measure URL lengths. If the existing serializer is too slow, optimize or schedule it; do not create a competing viewer-state format.

Ordinary viewer changes must cause no schema serialization, data reload, layout, routing, or DuckDB work attributable to persistence. Complete schema writes occur only on editor Done, committed edge-decision actions, import, or explicit local-copy creation.

## 12. Acceptance tests

1. Old published permalinks reconstruct unchanged without IndexedDB.
2. Discrete and continuous viewer changes update the URL; refresh reconstructs the latest URL state.
3. Entering/leaving the editor unchanged writes no schema; hundreds of assignments followed by Done write one complete local snapshot.
4. Later editor commits reuse the same ID and advance its revision; a refresh during editing discards only uncommitted changes.
5. A failed editor commit preserves the working copy, offers Retry/Export Draft, and does not advance the URL.
6. Excluding an edge creates/updates a local schema, including the private reason; refresh preserves exclusion and reason. A failed decision commit is visibly unsaved and recoverable.
7. Publishing preserves exclusion status but final uploaded schema files, manifests, and compiled DAG bytes contain no reason value or private reason field. A fresh browser reconstructs the published status without IndexedDB.
8. A local URL in a fresh profile reports its schema unavailable, with no schema content or reasons embedded in that URL.
9. Bare root starts a fresh view even when Previous Sessions contains older entries; the user can select one to restore.
10. A crash between schema transaction completion and URL replacement leaves the committed schema discoverable from its Previous Sessions entry.
11. An older asynchronous URL mirror cannot overwrite a newer URL for the same session or schema commit.
12. Concurrent tabs cannot silently overwrite a newer local revision; Save as Independent Local Copy does not alter the original.
13. Import creates an independent local schema and reconstructs through the existing permalink path.
14. Existing published artifacts are audited for private reasons and any discovered exposure has a remediation decision before release.
15. URL updates meet responsiveness targets without triggering schema serialization or graph recomputation during ordinary viewer interactions.

## 13. Delivery phases

1. **Audit and unified references:** map current URL, bootstrap, schema, editor, and publication flows; add local schema resolution while preserving published link semantics.
2. **Editor isolation and local commits:** introduce working copy, Done/Discard, complete IndexedDB snapshots, revision checks, failure handling, and crash recovery.
3. **Live URLs and Previous Sessions:** coordinate viewer URL updates, persist one latest URL string per local session, start fresh at root, and add deliberate restoration from the button.
4. **Edge decisions and privacy:** persist local decisions/reasons, define the public projection, sanitize all publication paths, test uploaded bytes, and audit existing public artifacts.
5. **Import/export and resilience:** add draft export/import, missing-schema UI, save status, and multi-tab conflict choices.
6. **Performance validation:** benchmark realistic graphs and eliminate persistence-related interaction regressions.

## 14. Definition of done

Published permalinks remain deterministic; local URLs resolve committed mutable schemas in the same reconstruction pipeline; URL updates track viewer state; editor edits are isolated until Done; local edge decisions persist with private reasons; public artifacts preserve exclusion status without reasons; crashes recover the latest committed schema and available URL under normal intact-storage conditions; concurrent commits do not silently overwrite; and viewer responsiveness does not materially regress.
