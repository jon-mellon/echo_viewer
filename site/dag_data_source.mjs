import * as duckdb from "./vendor/duckdb/duckdb-browser.mjs";
import { evidenceManifestUrl, groupingSchemaUrl, schemaPublicationId } from "./dag_data_config.mjs";
import { manifestFileEntries } from "./dag_manifest.mjs";
import { loadGroupingSchema } from "./grouping_schema_loader.mjs";
import { loadPublishedSchema } from "./published_schema_loader.mjs";

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
  }

  async initialize() {
    if (this.connection || this.compiledPublishedLoad) return;
    const publicationId = schemaPublicationId();
    if (publicationId) {
      this.onStatus("Loading published schema and compiled DAG…");
      const loaded = await loadPublishedSchema(publicationId);
      this.groupingSet = loaded.schema;
      this.loadedPublication = loaded.publication;
      if (loaded.compiledDag && !this.skipCompiledOnce) {
        this.compiledPublishedLoad = loaded;
        return;
      }
      this.skipCompiledOnce = false;
      this.onStatus(`Compiled DAG unavailable (${loaded.compiledFallbackReason}); loading legacy evidence…`);
    }
    const manifestUrl = new URL(this.manifestUrl, window.location.href);
    this.onStatus("Loading evidence manifest…");
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load DAG snapshot manifest ${manifestUrl.href}: HTTP ${response.status}`);
    this.manifest = await response.json();
    const files = manifestFileEntries(this.manifest.files);
    this.onStatus("Loading grouping schema…");
    if (!publicationId) {
      this.groupingSet = await loadGroupingSchema(this.schemaUrl);
      this.loadedPublication = null;
    } else {
      const manifestEvidenceIds = new Set([this.manifest.snapshot_id,
        this.manifest.cache_compatibility?.record_signature, this.manifest.record_signature].filter(Boolean));
      if (this.loadedPublication.evidence_snapshot && !manifestEvidenceIds.has(this.loadedPublication.evidence_snapshot)) {
        throw new Error("Legacy publication evidence snapshot does not match the current evidence manifest.");
      }
    }

    this.onStatus("Starting query engine…");
    const mainModule = new URL("./vendor/duckdb/duckdb-eh.wasm", import.meta.url).href;
    const mainWorker = new URL("./vendor/duckdb/duckdb-browser-eh.worker.js", import.meta.url).href;
    const worker = new Worker(mainWorker);
    const database = new duckdb.AsyncDuckDB(
      new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
      worker,
    );
    await database.instantiate(mainModule);
    this.connection = await database.connect();
    for (const [index, { relation, sqlIdentifier, file }] of files.entries()) {
      this.onStatus(`Preparing evidence tables (${index + 1} of ${files.length})…`);
      const url = new URL(file.url, manifestUrl).href.replaceAll("'", "''");
      await this.connection.query(
        `CREATE VIEW ${sqlIdentifier} AS SELECT * FROM read_parquet('${url}')`,
      );
    }
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
        variables: [], raw_causal_links: [], similarity_edges: [],
        layout: { active_source: layoutSource || "", default_source: "" },
        snapshot: { snapshot_id: publication.evidence_snapshot },
        load_metrics: { raw_r2_bytes_before_render: 0, raw_r2_rows_before_render: 0 },
      };
    }
    this.onStatus("Querying variables and relationships…");
    const metadata = await queryRows(this.connection, "SELECT metadata_json FROM build_metadata");
    const payload = JSON.parse(metadata[0].metadata_json);
    const selectedSource = layoutSource || payload.layout.default_source;
    const variables = await queryRows(this.connection, `
      SELECT o.*, i.canonical_variable_id, l.map_x, l.map_y
      FROM variable_occurrences o
      JOIN variable_layouts l USING (variable_id)
      JOIN canonical_identities i USING (variable_id, layout_source)
      WHERE l.layout_source = ? ORDER BY o.index
    `, [selectedSource]);
    const neighbors = await queryRows(
      this.connection,
      "SELECT * FROM variable_neighbors ORDER BY variable_id, display_rank",
    );
    const neighborsByVariable = new Map();
    for (const row of neighbors) {
      if (!neighborsByVariable.has(row.variable_id)) neighborsByVariable.set(row.variable_id, []);
      neighborsByVariable.get(row.variable_id).push({
        variable_id: row.neighbor_variable_id,
        index: row.neighbor_index,
        cosine_similarity: row.cosine_similarity,
        llm_rank: row.llm_rank,
        embedding_rank: row.embedding_rank,
        is_substantive_duplicate: row.is_substantive_duplicate,
      });
    }
    for (const variable of variables) {
      variable.field_preview = JSON.parse(variable.field_preview_json);
      variable.metadata_blob = JSON.parse(variable.metadata_blob_json);
      variable.similarity_neighbors = neighborsByVariable.get(variable.variable_id) || [];
      delete variable.field_preview_json;
      delete variable.metadata_blob_json;
      delete variable.layout_source;
    }

    payload.grouping_sets = [this.groupingSet];
    payload.publication_source = this.loadedPublication ? {
      publication_id: this.loadedPublication.id,
      content_hash: this.loadedPublication.content_hash,
      parent_publication_id: this.loadedPublication.parent_schema_id,
      storage_prefix: this.loadedPublication.storage_prefix,
    } : null;
    payload.default_grouping_set_id = this.groupingSet.grouping_set_id;
    payload.layout.active_source = selectedSource;
    payload.variables = variables;
    payload.raw_causal_links = await queryRows(this.connection, "SELECT * FROM causal_link_occurrences");
    payload.similarity_edges = await queryRows(this.connection,
      "SELECT source, target, weight, kind FROM similarity_edges WHERE layout_source = ?",
      [selectedSource]);
    payload.snapshot = {
      schema_version: this.manifest.schema_version,
      snapshot_id: this.manifest.snapshot_id,
    };
    return payload;
  }

  async loadVariableMetadata(variableIds, layoutSource = "") {
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    return queryRows(this.connection, `SELECT o.*, i.canonical_variable_id, l.map_x, l.map_y
      FROM variable_occurrences o JOIN variable_layouts l USING (variable_id)
      JOIN canonical_identities i USING (variable_id, layout_source)
      WHERE l.layout_source = ? AND o.variable_id IN (${placeholders}) ORDER BY o.index`,
      [layoutSource || this.manifest?.layout?.default_source || "", ...variableIds]);
  }

  async loadIncidentRawLinks(variableIds) {
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    return queryRows(this.connection, `SELECT * FROM causal_link_occurrences
      WHERE source_variable_id IN (${placeholders}) OR target_variable_id IN (${placeholders})`,
      [...variableIds, ...variableIds]);
  }

  async loadAllRawLinks() {
    await this.ensureEvidenceConnection();
    return queryRows(this.connection, "SELECT * FROM causal_link_occurrences");
  }

  async loadRawLinksByIds(rawLinkIds) {
    await this.ensureEvidenceConnection();
    if (!rawLinkIds?.length) return [];
    const placeholders = rawLinkIds.map(() => "?").join(",");
    return queryRows(this.connection, `SELECT * FROM causal_link_occurrences
      WHERE raw_causal_link_id IN (${placeholders})`, rawLinkIds);
  }

  async loadNeighbors(variableIds) {
    await this.ensureEvidenceConnection();
    if (!variableIds?.length) return [];
    const placeholders = variableIds.map(() => "?").join(",");
    return queryRows(this.connection, `SELECT * FROM variable_neighbors
      WHERE variable_id IN (${placeholders}) ORDER BY variable_id, display_rank`, variableIds);
  }

  async ensureEvidenceConnection() {
    if (this.connection) return;
    // A compiled publication intentionally deferred R2/DuckDB setup until detail
    // or editing asks for a narrowly filtered relation.
    const saved = this.compiledPublishedLoad;
    this.compiledPublishedLoad = null;
    this.skipCompiledOnce = true;
    await this.initialize();
    this.compiledPublishedLoad = saved;
  }
}

export const dagDataSource = new ParquetManifestDagDataSource();
