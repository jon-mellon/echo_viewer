# Per-snapshot viewer assets

Updated: 2026-11-06

The viewer reads evidence from an immutable **evidence snapshot** on the data host. Querying it directly needs the
DuckDB WebAssembly engine (a 34 MB download, plus extensions and large Parquet files), which is slow on a phone. For the
common questions the viewer instead reads small precomputed files, each a pure function of one snapshot. When a snapshot
has none the viewer silently falls back to the engine: the app still works, but very much slower. On a Slow-4G connection
with a 4x CPU slowdown, opening a saved variable took more than two minutes without them (it never finished) and about
one second with them.

## Who builds them and where they live

The **data pipeline** builds them with the snapshot and publishes them beside it; this repo no longer commits them.
They are produced by `harvest_abstracts/analysis/10k/echo_viewer_bundle/viewer_assets.py`, which the bundle builders call
(failing the build if the set is incomplete or does not cover every schema group), the validator re-checks, and the
uploader requires before it will publish a snapshot. They sit under the snapshot's layout folder, behind one sidecar
manifest the viewer discovers:

```
https://data.epistemicinfra.org/evidence/layouts/browser-v2/<snapshot>/viewer-assets/
  manifest.json              format echo-viewer-assets-v1; lists each asset with its size and SHA-256
  search-catalog.json.gz     variable labels for search
  variable-maps/             one file per variable group (category), plus index.json.gz
  variable-neighbors/        neighbors bucketed by the first two hex characters of a variable id
  variable-incidents/        raw links bucketed the same way
  evidence-panels/           the evidence behind each grouped edge
```

The existing snapshot files are never rewritten (they are immutable and cached for a year); the sidecar is a new key.

## How the viewer finds and uses them

`site/viewer_assets.mjs` fetches `viewer-assets/manifest.json` for the snapshot once (`ParquetManifestDagDataSource.bindViewerAssets`),
before any catalog is consulted, and binds what it lists into the catalogs, replacing any committed binding for that
snapshot. Every file is verified against the size and SHA-256 in its index before use. If a snapshot has no sidecar the
committed bindings (below) are used, and if there are none the viewer falls back to the engine, with a console warning
and an `echo:viewer-assets:missing` performance mark so the slow path is never silent.

Formats are the contract between the two repos. `tests/fixtures/viewer-assets/` is the output of `viewer_assets.py` for a
six-variable snapshot, and `tests/viewer_assets.test.mjs` opens every kind of asset from it through the real catalogs.

### How a variable map bundle is matched

The pipeline groups the snapshot's variables by `category`, writes one file per group, and keys it by
`sha256(sorted unique variable ids joined by "\n")`. The viewer hashes the ids it wants and looks for that key, so a lookup
only hits for **exactly** a published group. A custom or split variable, a group with a split carved out of it, or a
partly loaded group falls back to the engine. The pipeline checks that every group of the grouping schema it builds has a
bundle.

## Promoting a snapshot to the default

`scripts/check_snapshot_assets.mjs` (`npm run check:snapshot-assets`) runs in the deploy and profile workflows. It fetches the
default snapshot's sidecar from the data host, checks every file it lists, and fails if anything is missing or changed.
If nothing is published yet it accepts the bundles committed under `site/` with a warning, and fails if there are neither.
Once a snapshot's assets are published, delete its committed bundles (`site/variable-maps/<snapshot>/`,
`site/search-catalogs/<snapshot>.json.gz` and the matching binding entries); the check then becomes the only gate.

A snapshot built before this existed can be backfilled from the public data host without the original run (see the
pipeline's README).

## Committed bindings (fallback)

| Asset | Table | Generator |
| --- | --- | --- |
| Search catalog | `SNAPSHOT_SEARCH_CATALOGS` in `site/variable_search_catalog.mjs` | `scripts/generate_variable_search_catalog.mjs` |
| Variable maps | `VARIABLE_MAP_BINDINGS` in `site/variable_map_catalog.mjs` | `scripts/generate_variable_maps.mjs` |
| Neighbors, incidents, evidence panels | `VARIABLE_NEIGHBOR_BINDINGS`, `VARIABLE_INCIDENT_BINDINGS`, `EVIDENCE_PANEL_BINDINGS` | `scripts/generate_variable_neighbors.mjs`, `scripts/generate_evidence_panels.mjs` |

`scripts/register_snapshot_assets.mjs` generates and registers the first two offline. These are a fallback for working
offline or for a snapshot the pipeline did not build; the pipeline's Python port of the generators was checked to produce
decoded payloads identical to these on the current snapshot.

The current default snapshot (`8bf2706808428e59109baa285690135cdbe066e26d97a7d820c9935fc3881849`) has no committed
bundles: its assets are published to the data host by the pipeline and `npm run check:snapshot-assets` gates the deploy.
The earlier committed bundles are recoverable from git history and regenerable with `scripts/register_snapshot_assets.mjs`.
