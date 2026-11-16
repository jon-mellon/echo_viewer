import { EchoSessionCore } from "./echo_session_core.mjs";
import { DEFAULT_SCHEMA_PUBLICATION_ID, evidenceManifestUrl, evidenceSnapshotIdFromManifestUrl } from "./dag_data_config.mjs";
import { incrementCompiledDag, fullCompileDag } from "./compiled_dag.mjs";
import { loadPublishedSchema } from "./published_schema_loader.mjs";
import { StaticVariableSearchCatalog } from "./variable_search_catalog.mjs";
import { ensureOwner } from "./cloudflare_api.mjs";
import { validateGroupingSchema } from "./data_validation.mjs";
import { publicationPermalink } from "./published_schema_loader.mjs";
import { digest } from "./paper_review_contract.mjs";

export class BrowserEchoSession extends EchoSessionCore {
  async jevEstimate(args) {
    const estimate = await super.jevEstimate(args);
    return this.runtime.classifierModel && estimate.model
      ? { ...estimate, model: this.runtime.classifierModel, estimateNote: "Approximate token estimate; split classification uses the pinned pipeline model." } : estimate;
  }
  static async start({ record = null, save, getKey, request, onStatus = () => {}, publicationId = DEFAULT_SCHEMA_PUBLICATION_ID }) {
    const { ParquetManifestDagDataSource } = await import("./dag_data_source.mjs");
    const loaded = await loadPublishedSchema(record?.sourcePublication.id || publicationId);
    if (record && record.sourcePublication.content_hash !== loaded.publication.content_hash) throw new Error("Pinned schema hash changed.");
    const { schema } = await loaded.loadSchema(); // Includes membership and canonical folder hash verification.
    validateGroupingSchema(schema);
    const manifestUrl = evidenceManifestUrl(null, loaded.publication.evidence_snapshot);
    const snapshotId = evidenceSnapshotIdFromManifestUrl(manifestUrl);
    if (record && record.snapshotId !== snapshotId) throw new Error("Pinned physical evidence snapshot changed.");
    const source = new ParquetManifestDagDataSource({ manifestUrl, onStatus });
    source.loadedPublication = loaded.publication;
    source.groupingSet = schema;
    source.compiledPublishedLoad = loaded;
    // Verify metadata/schema binding before any run can use the compiled DAG.
    await source.ensureEvidenceConnection({ variableIds: [] });
    const manifestHash = await digest(source.manifest);
    if (record && record.evidenceManifestHash !== manifestHash) throw new Error("Pinned evidence manifest changed.");
    await source.bindViewerAssets();
    const search = new StaticVariableSearchCatalog();
    const evidence = {
      variables: ids => source.loadVariableMetadata(ids),
      neighbors: ids => source.loadNeighbors(ids),
      incidentLinks: ids => source.loadIncidentRawLinks(ids),
      rawLinks: ids => {
        if (!ids) throw new Error("Browser reviews require explicit finding IDs; a full raw-link scan is disabled.");
        return source.loadRawLinksByIds(ids);
      },
      searchVariables: async (query, limit = 40) => {
        await search.loadSnapshot(snapshotId, { loadRecords: () => source.loadVariableSearchRecords() });
        return search.searchVariables(query, Math.max(1, Math.min(100, limit)));
      },
      candidateInputs: () => { throw new Error("Use the compiled distance-one confounder queue in this browser version."); },
      layoutSource: async () => source.defaultVariableLayoutSource || "",
    };
    const initial = record || { id: crypto.randomUUID(), status: "editing", revision: 0,
      sourcePublication: loaded.publication, snapshotId, baseSchema: schema, schema: structuredClone(schema),
      anchors: {}, operations: [], evidenceManifestHash: manifestHash, createdAt: new Date().toISOString() };
    const session = new BrowserEchoSession(initial, { evidence, save, getKey, request,
      ownerStorage: localStorage, checkOnlyVia: true, checkAdjustment: false });
    session.source = source;
    session.compiled = loaded.compiledDag;
    session.compiledSchema = structuredClone(schema);
    return session;
  }
  async compile() {
    const old = this.compiledSchema, next = this.schema;
    const owners = schema => new Map(schema.groups.flatMap(group => group.variable_ids.map(id => [id, group.group_id])));
    const a = owners(old), b = owners(next);
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter(id => a.get(id) !== b.get(id));
    const oldDecisions = old.finding_decisions || {}, nextDecisions = next.finding_decisions || {};
    const findings = [...new Set([...Object.keys(oldDecisions), ...Object.keys(nextDecisions)])]
      .filter(id => (oldDecisions[id]?.display_status === "excluded") !== (nextDecisions[id]?.display_status === "excluded"));
    const incident = [...(changed.length ? await this.source.loadIncidentRawLinks(changed) : []),
      ...(findings.length ? await this.source.loadRawLinksByIds(findings) : [])];
    if (findings.some(id => !incident.some(row => row.raw_causal_link_id === id))) throw new Error("A changed finding is absent from the pinned snapshot.");
    this.compiled = incrementCompiledDag({ compiledDag: this.compiled, oldSchema: old, newSchema: next,
      incidentRawLinks: incident, project: this.project });
    // The viewer overlays target orientation when anchors change. Recompile only
    // the former/current target pairs so MCP's graph sees the same target edge.
    const pair = (a, b) => [a, b].sort().join("\n");
    const target = pair(this.record.anchors.ivId || "", this.record.anchors.dvId || "");
    if (this.compiledAnchors !== target) {
      const pairs = new Map(this.compiled.edges.filter(edge => edge.is_target_relation)
        .map(edge => [pair(edge.group_a, edge.group_b), [edge.group_a, edge.group_b]]));
      if (this.record.anchors.ivId && this.record.anchors.dvId) pairs.set(target, [this.record.anchors.ivId, this.record.anchors.dvId]);
      for (const [key, ids] of pairs) {
        const prior = this.compiled.edges.filter(edge => pair(edge.group_a, edge.group_b) === key);
        const rawIds = [...new Set(prior.flatMap(edge => [...edge.a_to_b_raw_link_ids, ...edge.b_to_a_raw_link_ids]))];
        const rawLinks = rawIds.length ? await this.source.loadRawLinksByIds(rawIds) : [];
        if (rawLinks.length !== rawIds.length) throw new Error("Target-pair evidence is incomplete in the pinned snapshot.");
        const updated = fullCompileDag({ schema: { ...next, groups: next.groups.filter(group => ids.includes(group.group_id)) }, project: this.project, rawLinks });
        this.compiled.edges = [...this.compiled.edges.filter(edge => pair(edge.group_a, edge.group_b) !== key), ...updated.edges]
          .sort((a, b) => a.edge_id.localeCompare(b.edge_id));
      }
      this.compiledAnchors = target;
    }
    this.compiledSchema = structuredClone(next);
    return this.compiled;
  }
  async setAnchors(anchors) {
    for (const [role, id] of [["x", anchors.ivId], ["y", anchors.dvId]]) {
      const required = this.requiredFocal?.[role] || [];
      const group = this.schema.groups.find(row => row.group_id === id);
      if (required.length && !required.some(variable => group?.variable_ids.includes(variable))) {
        throw new Error(`The ${role} anchor omits the focal paper's verified variable occurrence. Inspect and correct its membership first.`);
      }
    }
    return super.setAnchors(anchors);
  }
  async jevApplySplit(args) {
    const role = ["iv", "exposure"].includes(args.role) ? "x" : ["dv", "outcome"].includes(args.role) ? "y" : null;
    const required = this.requiredFocal?.[role] || [];
    const classified = [...(this.record.jev?.test || []), ...(this.record.jev?.full || [])];
    if (required.some(id => classified.some(row => row.id === id))
      && !classified.some(row => required.includes(row.id) && row.side === "new")) {
      throw new Error("The Jev split excludes the verified focal variable. Inspect its match and explicitly override before applying.");
    }
    return super.jevApplySplit(args);
  }
  async publish(options) {
    // This runs in the Echo web origin, where the existing Turnstile integration is permitted.
    await ensureOwner();
    await super.publish(options);
    this.record.published.permalink = publicationPermalink(this.record.published.publicationId,
      { origin: location.origin, pathname: new URL("./", location.href).pathname }, { project: this.project,
        data: { snapshot: { snapshot_id: this.record.snapshotId } }, workflowMode: "dag",
        confounderMaxPathLength: 1, showConfoundersOnly: true });
    await this.save();
    return this.record.published;
  }
  async close() {
    await this.source.connection?.close();
    await this.source.neighborConnection?.close();
    await this.source.database?.terminate();
  }
}
