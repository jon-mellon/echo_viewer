import * as duckdb from "/vendor/duckdb/duckdb-browser.mjs";
import { evidenceManifestUrl, groupingSchemaUrl, schemaPublicationId } from "/dag_data_config.mjs";
import { loadGroupingSchema } from "/grouping_schema_loader.mjs";
import { loadPublishedSchema } from "/published_schema_loader.mjs";

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
    if (this.connection) return;
    const manifestUrl = new URL(this.manifestUrl, window.location.origin);
    this.onStatus("Loading evidence manifest…");
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load DAG snapshot manifest: ${response.status}`);
    this.manifest = await response.json();
    this.onStatus("Loading grouping schema…");
    const publicationId = schemaPublicationId();
    if (publicationId) {
      const loaded = await loadPublishedSchema(publicationId);
      this.groupingSet = loaded.schema;
      this.loadedPublication = loaded.publication;
    } else {
      this.groupingSet = await loadGroupingSchema(this.schemaUrl);
      this.loadedPublication = null;
    }

    this.onStatus("Starting query engine…");
    const mainModule = new URL("/vendor/duckdb/duckdb-eh.wasm", window.location.origin).href;
    const mainWorker = new URL("/vendor/duckdb/duckdb-browser-eh.worker.js", window.location.origin).href;
    const worker = new Worker(mainWorker);
    const database = new duckdb.AsyncDuckDB(
      new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING),
      worker,
    );
    await database.instantiate(mainModule);
    this.connection = await database.connect();
    const files = Object.entries(this.manifest.files);
    for (const [index, [relation, file]] of files.entries()) {
      this.onStatus(`Preparing evidence tables (${index + 1} of ${files.length})…`);
      const url = new URL(file.url, manifestUrl).href.replaceAll("'", "''");
      await this.connection.query(
        `CREATE VIEW ${relation} AS SELECT * FROM read_parquet('${url}')`,
      );
    }
  }

  async load(layoutSource = "") {
    await this.initialize();
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
}

export const dagDataSource = new ParquetManifestDagDataSource();
