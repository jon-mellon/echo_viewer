import * as duckdb from "./vendor/duckdb/duckdb-browser.mjs";
import { evidenceManifestUrl, evidenceSnapshotIdFromManifestUrl, groupingSchemaUrl,
  PRODUCTION_EVIDENCE_MANIFEST, schemaPublicationId } from "./dag_data_config.mjs";
import { browserV2ManifestLayout, browserV2ShardPath,
  validateBrowserV2EvidenceBinding } from "./dag_manifest.mjs";
import { loadGroupingSchema } from "./grouping_schema_loader.mjs";
import { loadPublishedSchema } from "./published_schema_loader.mjs?v=publication-v2";

// Reading many small remote Parquet shards incurs a separate metadata/range
// round trip for each shard. The canonical snapshot is cheaper for wide groups.
const CANONICAL_READ_SHARD_THRESHOLD = 8;
// This immutable evidence build's lookup has exactly one row for each index
// 1..14284, with shard_id = floor((variable_index - 1) / 256). The fallback
// below still reads the lookup for every other build.
const CONTIGUOUS_SHARD_SNAPSHOT = "99a8fd29ae81a1852ed181a62df01b989b99b536848bbf59f65a0ce8ea6871c0";
const CONTIGUOUS_SHARD_METADATA = Object.freeze({
  cache_compatibility: { record_signature: "5887939bf4e5d3619070a522f3ae11eee3f377c584bb8b2b3f77593c2b2248d4" },
  layout: { active_source: "category-probability-pca-v1", default_source: "category-probability-pca-v1" },
});

function plainRows(result) {
  return result.toArray().map((row) => {
    const value = row.toJSON();
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "bigint") value[key] = Number(item);
    }
    return value;
  });
}

async function queryRows(connection, sql, parameters = []) {
  if (!parameters.length) return plainRows(await connection.query(sql));
  const statement = await connection.prepare(sql);
  try {
    return plainRows(await statement.query(...parameters));
  } finally {
    await statement.close();
  }
}

/** Snapshot-backed data adapter; a direct DuckLake adapter can implement load(). */
export class ParquetManifestDagDataSource {
  constructor({ schemaUrl = groupingSchemaUrl(), manifestUrl = evidenceManifestUrl(), onStatus = () => {} } = {}) {
    this.connection = null;
    this.manifest = null;
    this.schemaUrl = schemaUrl;
    this.manifestUrl = manifestUrl;
    this.onStatus = onStatus;
    this.browserRelationScopes = new Map();
  }

  async initialize() {
    if (this.connection || this.compiledPublishedLoad) return;
    const publicationId = schemaPublicationId();
    // A compiled startup already resolved this immutable publication. Reuse
    // its binding when the same instance later opens the lazy evidence engine.
    if (publicationId && !(this.skipCompiledOnce && this.loadedPublication?.id === publicationId)) {
      const publicationStart = performance.now();
      this.onStatus("Loading published schema and compiled DAG…");
      const loaded = await loadPublishedSchema(publicationId);
      performance.measure("echo:evidence:publication", { start: publicationStart, end: performance.now() });
      this.groupingSet = loaded.schema;
      this.loadedPublication = loaded.publication;
      const permalinkVersion = new URL(globalThis.location?.href || "http://localhost/")
        .searchParams.get("data_version") || "";
      // Early publication permalinks accidentally wrote the evidence record
      // signature as data_version. Preserve those links while newly generated
      // links use the actual immutable snapshot-directory ID.
      if (permalinkVersion && permalinkVersion === loaded.publication.evidence_snapshot) {
        this.manifestUrl = PRODUCTION_EVIDENCE_MANIFEST;
      }
      if (loaded.compiledDag && !this.skipCompiledOnce) {
        this.compiledPublishedLoad = loaded;
        return;
      }
      this.skipCompiledOnce = false;
      this.onStatus(`Compiled DAG unavailable (${loaded.compiledFallbackReason}); checking browser-v2 evidence…`);
    }
    const manifestUrl = new URL(this.manifestUrl, window.location.href);
    const manifestStart = performance.now();
    this.onStatus("Loading evidence manifest…");
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load DAG snapshot manifest ${manifestUrl.href}: HTTP ${response.status}`);
    this.manifest = await response.json();
    performance.measure("echo:evidence:manifest", { start: manifestStart, end: performance.now() });
    this.manifestBaseUrl = manifestUrl;
    this.browserLayout = browserV2ManifestLayout(this.manifest);
    this.onStatus("Loading grouping schema…");
    if (!publicationId) {
      this.groupingSet = await loadGroupingSchema(this.schemaUrl);
      this.loadedPublication = null;
    }
    const expectedRecordSignature = this.loadedPublication?.evidence_snapshot
      || this.groupingSet?.built_against?.record_signature
      || this.groupingSet?.cache_compatibility?.record_signature;

    this.onStatus("Starting query engine…");
    const engineStart = performance.now();
    const mainModule = new URL("./vendor/duckdb/duckdb-eh.wasm", import.meta.url).href;
    const mainWorker = new URL("./vendor/duckdb/duckdb-browser-eh.worker.js", import.meta.url).href;
    const worker = new Worker(mainWorker);
    const database = new duckdb.AsyncDuckDB(
      new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
      worker,
    );
    await database.instantiate(mainModule);
    this.connection = await database.connect();
    this.neighborConnection = await database.connect();
    performance.measure("echo:evidence:engine", { start: engineStart, end: performance.now() });
    const lookupStart = performance.now();
    await this.loadBrowserShardLookup();
    performance.measure("echo:evidence:lookup", { start: lookupStart, end: performance.now() });
    const validationStart = performance.now();
    validateBrowserV2EvidenceBinding({
      manifest: this.manifest,
      manifestUrl: this.manifestBaseUrl.href,
      metadata: await this.loadBuildMetadata(),
      expectedRecordSignature,
    });
    performance.measure("echo:evidence:validation", { start: validationStart, end: performance.now() });
    this.lazyEvidenceInit = false;
  }

  async load(layoutSource = "") {
    await this.initialize();
    if (this.compiledPublishedLoad) {
      const { schema, publication, compiledDag } = this.compiledPublishedLoad;
      return {
        grouping_sets: [schema], default_grouping_set_id: schema.grouping_set_id,
        publication_source: { publication_id: publication.id, content_hash: publication.content_hash,
          parent_publication_id: publication.parent_schema_id, storage_prefix: publication.storage_prefix },
        compiled_dag: compiledDag,
        load_published_schema: this.compiledPublishedLoad.loadSchema || null,
        variables: [], raw_causal_links: [], similarity_edges: [],
        layout: { active_source: layoutSource || "", default_source: "" },
        snapshot: { snapshot_id: evidenceSnapshotIdFromManifestUrl(this.manifestUrl) },
        load_metrics: { raw_r2_bytes_before_render: 0, raw_r2_rows_before_render: 0 },
      };
    }
    throw new Error("Browser-v2 requires a compiled published DAG for startup; full-snapshot reconstruction is not part of the retrieval layout.");
  }

  async loadVariableMetadata(variableIds, layoutSource = "") {
    const start = performance.now();
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    await this.ensureVariableLayouts();
    const selectedLayoutSource = layoutSource || this.defaultVariableLayoutSource;
    const placeholders = variableIds.map(() => "?").join(",");
    const canonical = this.browserShardIds(variableIds).length >= CANONICAL_READ_SHARD_THRESHOLD
      ? this.canonicalEvidenceRelationUrl("variable_occurrences") : "";
    const urls = (canonical ? [canonical] : this.browserUrls(this.browserLayout.variables, variableIds))
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    const rows = await queryRows(this.connection, `SELECT o.*, l.map_x, l.map_y
      FROM read_parquet([${urls}]) o JOIN variable_layouts l USING (variable_id)
      WHERE l.layout_source = ? AND o.variable_id IN (${placeholders}) ORDER BY o.index`,
    [selectedLayoutSource, ...variableIds]);
    performance.measure("echo:evidence:variables", { start, end: performance.now() });
    return rows;
  }

  async loadIncidentRawLinks(variableIds) {
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    return this.queryBrowserIncidentLinks(variableIds);
  }

  async loadAllRawLinks() {
    await this.ensureEvidenceConnection();
    await this.ensureBrowserRelation("causal_link_occurrences");
    return queryRows(this.connection, "SELECT * FROM causal_link_occurrences");
  }

  async loadRawLinksByIds(rawLinkIds) {
    await this.ensureEvidenceConnection();
    if (!rawLinkIds?.length) return [];
    const placeholders = rawLinkIds.map(() => "?").join(",");
    const canonicalUrl = this.canonicalEvidenceRelationUrl("causal_link_occurrences");
    if (canonicalUrl) {
      const url = canonicalUrl.replaceAll("'", "''");
      return queryRows(this.connection, `SELECT * FROM read_parquet('${url}')
        WHERE raw_causal_link_id IN (${placeholders})`, rawLinkIds);
    }
    // Older browser manifests did not advertise their canonical snapshot.
    // IDs carry no shard ownership, so those layouts must scan every source shard.
    await this.ensureBrowserRelation("causal_link_occurrences");
    return queryRows(this.connection, `SELECT * FROM causal_link_occurrences
      WHERE raw_causal_link_id IN (${placeholders})`, rawLinkIds);
  }

  async loadNeighbors(variableIds) {
    const start = performance.now();
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    const canonical = this.browserShardIds(variableIds).length >= CANONICAL_READ_SHARD_THRESHOLD
      ? this.canonicalEvidenceRelationUrl("variable_neighbors") : "";
    const urls = (canonical ? [canonical] : this.browserUrls(this.browserLayout.neighbors, variableIds))
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    const rows = await queryRows(this.neighborConnection || this.connection, `SELECT * FROM read_parquet([${urls}])
      WHERE variable_id IN (${placeholders}) ORDER BY variable_id, display_rank`, variableIds);
    performance.measure("echo:evidence:neighbors", { start, end: performance.now() });
    return rows;
  }

  async ensureEvidenceConnection() {
    if (this.evidenceInitialization) return this.evidenceInitialization;
    if (this.connection) return;
    // A compiled publication intentionally deferred R2/DuckDB setup until detail
    // or editing asks for a narrowly filtered relation.
    this.evidenceInitialization = (async () => {
      const saved = this.compiledPublishedLoad;
      this.compiledPublishedLoad = null;
      this.skipCompiledOnce = true;
      this.lazyEvidenceInit = true;
      try {
        await this.initialize();
      } finally {
        this.compiledPublishedLoad = saved;
        this.evidenceInitialization = null;
      }
    })();
    return this.evidenceInitialization;
  }

  async loadBrowserShardLookup() {
    if (this.isContiguousShardSnapshot()) {
      this.contiguousShardMaxIndex = 14284;
      return;
    }
    const url = new URL(this.browserLayout.lookup, this.manifestBaseUrl).href.replaceAll("'", "''");
    const rows = await queryRows(this.connection, `SELECT variable_index, shard_id FROM read_parquet('${url}')`);
    this.shardByVariableIndex = new Map(rows.map(row => [Number(row.variable_index), Number(row.shard_id)]));
  }

  async ensureVariableLayouts() {
    if (this.variableLayoutsReady) return this.variableLayoutsReady;
    this.variableLayoutsReady = (async () => {
      const payload = await this.loadBuildMetadata();
      this.defaultVariableLayoutSource = payload.layout?.default_source || payload.layout?.active_source;
      if (!this.defaultVariableLayoutSource) throw new Error("Evidence snapshot has no default variable layout.");
      const legacyManifest = this.manifest.identity.legacy_manifest;
      const legacyBase = new URL(`/${legacyManifest}`, this.manifestBaseUrl);
      const quote = url => new URL(url, legacyBase).href.replaceAll("'", "''");
      await this.connection.query(`CREATE OR REPLACE VIEW variable_layouts AS
        SELECT * FROM read_parquet('${quote("variable_layouts.parquet")}')`);
    })();
    try {
      await this.variableLayoutsReady;
    } catch (error) {
      this.variableLayoutsReady = null;
      throw error;
    }
  }

  async loadBuildMetadata() {
    if (this.buildMetadata) return this.buildMetadata;
    if (this.isContiguousShardSnapshot()) {
      this.buildMetadata = CONTIGUOUS_SHARD_METADATA;
      return this.buildMetadata;
    }
    const url = this.canonicalEvidenceRelationUrl("build_metadata");
    if (!url) throw new Error("Browser-v2 evidence manifest does not identify its build metadata.");
    const rows = await queryRows(this.connection,
      `SELECT metadata_json FROM read_parquet('${url.replaceAll("'", "''")}')`);
    this.buildMetadata = JSON.parse(rows[0]?.metadata_json || "{}");
    return this.buildMetadata;
  }

  canonicalEvidenceRelationUrl(relation) {
    const legacyManifest = this.manifest?.identity?.legacy_manifest;
    const file = this.manifest?.identity?.legacy_relation_integrity?.[relation]?.url;
    if (!legacyManifest || !file || !this.manifestBaseUrl) return "";
    return new URL(file, new URL(`/${legacyManifest}`, this.manifestBaseUrl)).href;
  }

  isContiguousShardSnapshot() {
    return this.manifest?.evidence_snapshot === CONTIGUOUS_SHARD_SNAPSHOT
      && this.manifest?.shards?.count === 56
      && this.manifestBaseUrl?.hostname === "data.epistemicinfra.org"
      && this.manifestBaseUrl?.pathname === `/evidence/layouts/browser-v2/${CONTIGUOUS_SHARD_SNAPSHOT}/manifest.json`;
  }

  browserShardIds(variableIds) {
    const shards = new Set();
    for (const variableId of variableIds || []) {
      const match = String(variableId).match(/^v(\d+)$/);
      const index = match ? Number(match[1]) : NaN;
      const shard = this.contiguousShardMaxIndex
        ? (index >= 1 && index <= this.contiguousShardMaxIndex ? Math.floor((index - 1) / 256) : undefined)
        : this.shardByVariableIndex?.get(index);
      if (shard != null) shards.add(shard);
    }
    return [...shards].sort((a, b) => a - b);
  }

  browserUrls(pattern, variableIds) {
    const shardIds = variableIds ? this.browserShardIds(variableIds)
      : Array.from({ length: this.manifest.shards.count }, (_, index) => index);
    return shardIds.map(shard => new URL(browserV2ShardPath(pattern, shard), this.manifestBaseUrl).href);
  }

  async ensureBrowserRelation(relation, variableIds = null) {
    const suffix = variableIds ? this.browserShardIds(variableIds).join("_") : "all";
    if (this.browserRelationScopes.get(relation) === suffix) return;
    const patterns = {
      variable_occurrences: this.browserLayout.variables,
      variable_neighbors: this.browserLayout.neighbors,
      causal_link_occurrences: this.browserLayout.causal_links_by_source,
    };
    const pattern = patterns[relation];
    if (!pattern) throw new Error(`Unknown browser-v2 relation ${relation}.`);
    const urls = this.browserUrls(pattern, variableIds).map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    await this.connection.query(`CREATE OR REPLACE VIEW "${relation}" AS SELECT * FROM read_parquet([${urls}])`);
    this.browserRelationScopes.set(relation, suffix);
  }

  async queryBrowserIncidentLinks(variableIds) {
    const placeholders = variableIds.map(() => "?").join(",");
    const sourceUrls = this.browserUrls(this.browserLayout.causal_links_by_source, variableIds)
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    const targetUrls = this.browserUrls(this.browserLayout.causal_links_by_target, variableIds)
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    return queryRows(this.connection, `SELECT * EXCLUDE (projection_order) FROM (
      SELECT *, 1 projection_order FROM read_parquet([${sourceUrls}]) WHERE source_variable_id IN (${placeholders})
      UNION ALL
      SELECT *, 2 projection_order FROM read_parquet([${targetUrls}]) WHERE target_variable_id IN (${placeholders})
    ) QUALIFY row_number() OVER (PARTITION BY raw_causal_link_id ORDER BY projection_order) = 1`,
    [...variableIds, ...variableIds]);
  }
}

export const dagDataSource = new ParquetManifestDagDataSource();
