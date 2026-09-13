# DAG viewer synthetic acceptance baseline

This baseline exercises viewer graph behavior without using the research corpus.
All group names, variable IDs, links, timestamps, and provenance fields are
synthetic. The fixture contains no DOI, source-record UUID, paper text, model
output, developer path, branch name, or commit identifier.

## Fixture

- Project: `artifacts/playwright-2026-08-31/project-fixture.json`
- Topology oracle: `artifacts/playwright-2026-08-31/topology-manifest.json`
- Independent variable: `exposure`
- Dependent variable: `outcome`
- Generator: `generate_synthetic_fixtures.mjs`

The graph deliberately includes:

- a direct confounder, including one bidirectional link;
- a two-edge confounder with disjoint IV and DV witness paths;
- a bottlenecked candidate whose witness paths share an intermediate node;
- a four-edge confounder for maximum-path behavior;
- a collider with two-edge witness paths from both anchors; and
- an IV-to-DV target relationship.

This structure preserves coverage of causal/all-links views, maximum path
lengths, bottleneck exclusion, path-links-only filtering, direction handling,
collider detection, mediator roles, and deterministic witness selection.

## Topology checkpoints

The eleven working-map exports correspond to the viewer states exercised by
`dag_graph_fixture.test.mjs`:

- `02-causal-view.json`
- `03-all-links-view.json`
- `05-path-1.json`
- `06-path-2.json`
- `07-path-3.json`
- `08-path-4-full.json`
- `09-path-4-bottleneck.json`
- `10-path-4-bottleneck-path-links.json`
- `10-path-4-path-links.json`
- `13-path-99.json`
- `20-path-1-path-links.json`

For each checkpoint, the manifest records the complete synthetic node and edge
set, direction counts, and a canonical SHA-256 hash. The unit test independently
recomputes the graph from `project-fixture.json` and compares its node count,
edge count, and hash with the manifest.

## Regeneration

From `python/variable_wip/embedding_viewer_runtime`, run:

```sh
node tests/acceptance/generate_synthetic_fixtures.mjs
node tests/acceptance/build_topology_manifest.mjs
node --test tests/dag_graph_fixture.test.mjs
```

Do not regenerate snapshots merely because a test fails. First establish that
the graph change is intentional and document the changed behavior.
