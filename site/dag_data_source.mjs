import * as duckdb from "./vendor/duckdb/duckdb-browser.mjs";
import { evidenceManifestUrl, evidenceSnapshotIdFromManifestUrl, groupingSchemaUrl,
  schemaPublicationId } from "./dag_data_config.mjs";
import { browserV2ManifestLayout, browserV2ShardPath,
  validateBrowserV2EvidenceBinding } from "./dag_manifest.mjs";
import { loadGroupingSchema } from "./grouping_schema_loader.mjs";
import { loadPublishedSchema } from "./published_schema_loader.mjs?v=publication-v2";

// Reading many small remote Parquet shards incurs a separate metadata/range
// round trip for each shard. The canonical snapshot is cheaper for wide groups.
const CANONICAL_READ_SHARD_THRESHOLD = 8;
const RAW_LINK_QUERY_BATCH_SIZE = 2048;
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
      this.manifestUrl = evidenceManifestUrl(globalThis.location, loaded.publication.evidence_snapshot);
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
    const mapDownloads = this.prewarmMapFiles ? this.downloadMapFiles() : null;
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
    if (mapDownloads) {
      for (const file of await mapDownloads) {
        if (!file) continue;
        await database.registerFileBuffer(file.name, file.bytes);
        this.localParquetFiles ||= new Map();
        this.localParquetFiles.set(file.url, file.name);
      }
    }
    const lookupStart = performance.now();
    await this.ensureBrowserShardLookup(this.initialLookupIds ?? null);
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

  async loadVariableSearchRecords() {
    await this.ensureEvidenceConnection({ variableIds: [] });
    const canonical = this.canonicalEvidenceRelationUrl("variable_occurrences");
    const urls = canonical ? [canonical] : this.browserUrls(this.browserLayout.variables);
    const quoted = urls.map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    return queryRows(this.connection, `SELECT variable_id, display_label, concept_label,
      raw_variable_text, paper_id, uoa, index FROM read_parquet([${quoted}]) ORDER BY index`);
  }

  async loadVariableMetadata(variableIds, layoutSource = "", { mapOnly = false } = {}) {
    const start = performance.now();
    await this.ensureEvidenceConnection({ variableIds });
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    const layoutStart = performance.now();
    await this.ensureVariableLayouts();
    performance.measure("echo:evidence:variable-layouts", { start: layoutStart, end: performance.now() });
    const selectedLayoutSource = layoutSource || this.defaultVariableLayoutSource;
    const placeholders = variableIds.map(() => "?").join(",");
    const canonical = this.browserShardIds(variableIds).length >= CANONICAL_READ_SHARD_THRESHOLD
      ? this.canonicalEvidenceRelationUrl("variable_occurrences") : "";
    const urls = (canonical ? [canonical] : this.browserUrls(this.browserLayout.variables, variableIds))
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    const queryStart = performance.now();
    const columns = mapOnly ? "o.* EXCLUDE (field_preview_json, metadata_blob_json)" : "o.*";
    const compactIds = variableIds.length > 32;
    const requestedIds = compactIds ? "SELECT unnest(CAST(? AS JSON)::VARCHAR[])" : placeholders;
    const rows = await queryRows(this.connection, `SELECT ${columns}, l.map_x, l.map_y
      FROM read_parquet([${urls}]) o JOIN variable_layouts l USING (variable_id)
      WHERE l.layout_source = ? AND o.variable_id IN (${requestedIds}) ORDER BY o.index`,
    [selectedLayoutSource, ...(compactIds ? [JSON.stringify(variableIds)] : variableIds)]);
    performance.measure("echo:evidence:variables-query", { start: queryStart, end: performance.now() });
    performance.measure("echo:evidence:variables", { start, end: performance.now() });
    return rows;
  }

  async loadVariableProvenance(variableIds) {
    await this.ensureEvidenceConnection({ variableIds });
    if (!variableIds?.length || !this.browserShardIds(variableIds).length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    const urls = this.browserUrls(this.browserLayout.variables, variableIds)
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    return queryRows(this.connection, `SELECT variable_id, concept_label, display_label
      FROM read_parquet([${urls}]) WHERE variable_id IN (${placeholders})`, variableIds);
  }

  async loadIncidentRawLinks(variableIds) {
    await this.ensureEvidenceConnection({ variableIds });
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    return this.queryBrowserIncidentLinks(variableIds);
  }

  async loadAllRawLinks() {
    await this.ensureEvidenceConnection({ variableIds: [] });
    await this.ensureBrowserRelation("causal_link_occurrences");
    return queryRows(this.connection, "SELECT * FROM causal_link_occurrences");
  }

  async loadRawLinksByIds(rawLinkIds) {
    await this.ensureEvidenceConnection({ variableIds: [] });
    if (!rawLinkIds?.length) return [];
    const canonicalUrl = this.canonicalEvidenceRelationUrl("causal_link_occurrences");
    if (!canonicalUrl) await this.ensureBrowserRelation("causal_link_occurrences");
    const relation = canonicalUrl
      ? `read_parquet('${canonicalUrl.replaceAll("'", "''")}')`
      : "causal_link_occurrences";
    // Bound both the WASM parameter buffer and result batches. A map can
    // reference tens of thousands of findings; one giant query can exhaust
    // DuckDB-WASM before any evidence is returned.
    const rows = [];
    const ids = [...new Set(rawLinkIds)];
    for (let offset = 0; offset < ids.length; offset += RAW_LINK_QUERY_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + RAW_LINK_QUERY_BATCH_SIZE);
      const placeholders = batch.map(() => "?").join(",");
      rows.push(...await queryRows(this.connection, `SELECT * FROM ${relation}
        WHERE raw_causal_link_id IN (${placeholders})`, batch));
    }
    return rows;
  }

  async loadRawLinkSupportByIds(rawLinkIds) {
    if (!rawLinkIds?.length) return [];
    await this.ensureEvidenceConnection({ variableIds: [] });
    const canonicalUrl = this.canonicalEvidenceRelationUrl("causal_link_occurrences");
    if (!canonicalUrl) await this.ensureBrowserRelation("causal_link_occurrences");
    const relation = canonicalUrl
      ? `read_parquet('${canonicalUrl.replaceAll("'", "''")}')`
      : "causal_link_occurrences";
    // One scan of three columns avoids repeatedly scanning full evidence rows
    // for a map-wide filter. Keep these partial records out of the detail cache.
    const requested = new Set(rawLinkIds);
    const columns = await queryRows(this.connection, `DESCRIBE SELECT * FROM ${relation}`);
    const claim = columns.some(column => column.column_name === "causal_link_existence")
      ? "causal_link_existence" : "NULL::VARCHAR AS causal_link_existence";
    return (await queryRows(this.connection, `SELECT raw_causal_link_id, paper_id,
      ${claim} FROM ${relation}`)).filter(row => requested.has(row.raw_causal_link_id));
  }

  async loadRawLinkEndpointsByIds(rawLinkIds) {
    if (!rawLinkIds?.length) return [];
    await this.ensureEvidenceConnection({ variableIds: [] });
    const canonicalUrl = this.canonicalEvidenceRelationUrl("causal_link_occurrences");
    if (!canonicalUrl) await this.ensureBrowserRelation("causal_link_occurrences");
    const relation = canonicalUrl
      ? `read_parquet('${canonicalUrl.replaceAll("'", "''")}')`
      : "causal_link_occurrences";
    const placeholders = rawLinkIds.map(() => "?").join(",");
    return queryRows(this.connection,
      `SELECT raw_causal_link_id, source_variable_id, target_variable_id FROM ${relation}
        WHERE raw_causal_link_id IN (${placeholders})`, rawLinkIds);
  }

  async loadNeighbors(variableIds) {
    const start = performance.now();
    await this.ensureEvidenceConnection({ variableIds });
    if (!variableIds?.length) return [];
    if (!this.browserShardIds(variableIds).length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    const canonical = this.browserShardIds(variableIds).length >= CANONICAL_READ_SHARD_THRESHOLD
      ? this.canonicalEvidenceRelationUrl("variable_neighbors") : "";
    const urls = (canonical ? [canonical] : this.browserUrls(this.browserLayout.neighbors, variableIds))
      .map(url => `'${url.replaceAll("'", "''")}'`).join(",");
    const queryStart = performance.now();
    const rows = await queryRows(this.neighborConnection || this.connection, `SELECT * FROM read_parquet([${urls}])
      WHERE variable_id IN (${placeholders}) ORDER BY variable_id, display_rank`, variableIds);
    performance.measure("echo:evidence:neighbors-query", { start: queryStart, end: performance.now() });
    performance.measure("echo:evidence:neighbors", { start, end: performance.now() });
    return rows;
  }

  async ensureEvidenceConnection({ variableIds = null, prewarmMapFiles = false } = {}) {
    if (prewarmMapFiles) this.prewarmMapFiles = true;
    if (this.evidenceInitialization) {
      await this.evidenceInitialization;
      return this.ensureBrowserShardLookup(variableIds);
    }
    if (this.connection) return this.ensureBrowserShardLookup(variableIds);
    // A compiled publication intentionally deferred R2/DuckDB setup until detail
    // or editing asks for a narrowly filtered relation.
    this.evidenceInitialization = (async () => {
      const saved = this.compiledPublishedLoad;
      this.compiledPublishedLoad = null;
      this.skipCompiledOnce = true;
      this.lazyEvidenceInit = true;
      this.initialLookupIds = variableIds;
      try {
        await this.initialize();
      } finally {
        this.compiledPublishedLoad = saved;
        this.evidenceInitialization = null;
      }
    })();
    await this.evidenceInitialization;
    return this.ensureBrowserShardLookup(variableIds);
  }

  async ensureBrowserShardLookup(variableIds = null) {
    if (this.shardLookupComplete) return;
    const ids = variableIds === null ? null : [...new Set(variableIds)];
    if (ids?.every(id => this.shardLookupQueriedIds?.has(id))) return;
    if (this.shardLookupLoading) {
      await this.shardLookupLoading;
      return this.ensureBrowserShardLookup(ids);
    }
    const pending = this.loadBrowserShardLookup(ids);
    this.shardLookupLoading = pending;
    try { await pending; }
    finally { if (this.shardLookupLoading === pending) this.shardLookupLoading = null; }
  }

  async loadBrowserShardLookup(variableIds = null) {
    if (this.isContiguousShardSnapshot()) {
      this.contiguousShardMaxIndex = 14284;
      this.shardLookupComplete = true;
      return;
    }
    const url = this.parquetFile(new URL(this.browserLayout.lookup, this.manifestBaseUrl).href).replaceAll("'", "''");
    const byId = this.browserLayout.lookup_key === "variable_id";
    const key = byId ? "variable_id" : "variable_index";
    let table;
    if (variableIds !== null) {
      const keys = byId ? variableIds : variableIds.map(id => Number(String(id).match(/^v(\d+)$/)?.[1])).filter(Number.isFinite);
      if (!keys.length) return;
      const compactIds = keys.length > 32;
      const requestedIds = compactIds ? `SELECT unnest(CAST(? AS JSON)::${byId ? 'VARCHAR' : 'BIGINT'}[])`
        : keys.map(() => '?').join(',');
      const statement = await this.connection.prepare(`SELECT ${key}, shard_id FROM read_parquet('${url}')
        WHERE ${key} IN (${requestedIds})`);
      try { table = await statement.query(...(compactIds ? [JSON.stringify(keys)] : keys)); }
      finally { await statement.close(); }
    } else table = await this.connection.query(`SELECT ${key}, shard_id FROM read_parquet('${url}')`);
    const keys = table.getChild(key), shards = table.getChild("shard_id");
    const lookup = new Map();
    // Arrow row proxies/toJSON allocate an object per row. Read the two columns
    // directly and yield while indexing large content-ID snapshots.
    for (let start = 0; start < table.numRows; start += 2000) {
      for (let i = start; i < Math.min(start + 2000, table.numRows); i++) {
        lookup.set(byId ? String(keys.get(i)) : Number(keys.get(i)), Number(shards.get(i)));
      }
      if (start + 2000 < table.numRows) {
        if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
        else await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    const field = byId ? "shardByVariableId" : "shardByVariableIndex";
    if (!this[field]) this[field] = lookup;
    else for (const [id, shard] of lookup) this[field].set(id, shard);
    if (variableIds === null) this.shardLookupComplete = true;
    else {
      this.shardLookupQueriedIds ||= new Set();
      for (const id of variableIds) this.shardLookupQueriedIds.add(id);
    }
  }

  async ensureVariableLayouts() {
    if (this.variableLayoutsReady) return this.variableLayoutsReady;
    this.variableLayoutsReady = (async () => {
      const metadataStart = performance.now();
      const payload = await this.loadBuildMetadata();
      performance.measure("echo:evidence:variable-layouts-metadata", { start: metadataStart, end: performance.now() });
      this.defaultVariableLayoutSource = payload.layout?.default_source || payload.layout?.active_source;
      if (!this.defaultVariableLayoutSource) throw new Error("Evidence snapshot has no default variable layout.");
      const legacyManifest = this.manifest.identity.legacy_manifest;
      const legacyBase = new URL(`/${legacyManifest}`, this.manifestBaseUrl);
      const quote = url => this.parquetFile(new URL(url, legacyBase).href).replaceAll("'", "''");
      const viewStart = performance.now();
      await this.connection.query(`CREATE OR REPLACE VIEW variable_layouts AS
        SELECT * FROM read_parquet('${quote("variable_layouts.parquet")}')`);
      performance.measure("echo:evidence:variable-layouts-view", { start: viewStart, end: performance.now() });
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
    const url = this.parquetFile(this.canonicalEvidenceRelationUrl("build_metadata"));
    if (!url) throw new Error("Browser-v2 evidence manifest does not identify its build metadata.");
    const rows = await queryRows(this.connection,
      `SELECT metadata_json FROM read_parquet('${url.replaceAll("'", "''")}')`);
    this.buildMetadata = JSON.parse(rows[0]?.metadata_json || "{}");
    return this.buildMetadata;
  }

  parquetFile(url) {
    return this.localParquetFiles?.get(url) || url;
  }

  async downloadMapFiles() {
    // These immutable map prerequisites are small enough to fetch together
    // during WASM startup. Verified buffers avoid serial remote Parquet footer
    // and range requests. An unavailable prefetch retains the remote SQL path.
    const lookupPath = this.browserLayout.lookup;
    const plans = [
      { kind: "lookup", url: new URL(lookupPath, this.manifestBaseUrl).href,
        integrity: this.manifest.files?.[lookupPath] },
      ...["build_metadata", "variable_layouts"].map(kind => ({ kind,
        url: this.canonicalEvidenceRelationUrl(kind),
        integrity: this.manifest.identity?.legacy_relation_integrity?.[kind] })),
    ];
    return Promise.all(plans.map(async ({ kind, url, integrity }) => {
      if (!url || !Number.isInteger(integrity?.bytes) || integrity.bytes < 1
        || integrity.bytes > 4 * 1024 * 1024 || !/^[0-9a-f]{64}$/i.test(integrity.sha256 || "")) return null;
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== integrity.bytes) return null;
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
          .map(value => value.toString(16).padStart(2, "0")).join("");
        if (hash !== integrity.sha256.toLowerCase()) return null;
        return { url, bytes, name: `echo-map-${this.manifest.evidence_snapshot}-${kind}.parquet` };
      } catch { return null; }
    }));
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
      if (this.shardByVariableId) {
        const shard = this.shardByVariableId.get(String(variableId));
        if (shard != null) shards.add(shard);
        continue;
      }
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
    const canonicalUrl = this.canonicalEvidenceRelationUrl("causal_link_occurrences");
    if (canonicalUrl) {
      // The canonical file has one row per raw link. A single Parquet binding
      // avoids preparing a union across many source and target shard files.
      const url = canonicalUrl.replaceAll("'", "''");
      return queryRows(this.connection, `SELECT * FROM read_parquet('${url}')
        WHERE source_variable_id IN (${placeholders}) OR target_variable_id IN (${placeholders})`,
      [...variableIds, ...variableIds]);
    }
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
