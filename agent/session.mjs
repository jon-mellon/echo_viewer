import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import * as projectOps from "../site/dag_project.mjs";
import * as visibility from "../site/variable_visibility.mjs";
import { confounderKey } from "../site/confounder_status.mjs";
import { fullCompileDag } from "../site/compiled_dag.mjs";
import { deriveDagView } from "../site/dag_view.mjs";
import { buildCandidateQueue } from "../site/dag_candidates.mjs";
import { groupNeighborSuggestions } from "../site/dag_search.mjs";
import { validateGroupingSchema } from "../site/data_validation.mjs";
import { canonicalizeWorkingSchema, publishWorkingSchema } from "../site/dag_publication_core.mjs";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../site/supabase_config.mjs";
import { DEFAULT_SCHEMA_PUBLICATION_ID } from "../site/dag_data_config.mjs";
import { publicationPermalink } from "../site/published_schema_loader.mjs";
import { browsePublishedSplits, loadPublishedSplitMembership } from "../site/published_split_browser.mjs";
import { JEV_BATCH_SIZE, JEV_TEST_SIZE, cappedKeyStatus, randomSampleIds,
  jevRecords, jevRequest, jevResults, openRouterJson, parseJevPricing,
  jevRequestSizes, estimatedJevCharge } from "../site/definition_jev_core.mjs";
import { agentHome, clonePublication, openLocalPublication, localEvidence } from "./local_data.mjs";

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_, item) => item instanceof Set ? [...item] : item instanceof Map ? Object.fromEntries(item) : item));
}
function ownGroup(schema, id) { return schema.groups.find(group => group.group_id === id); }
function projectFromSchema(schema, anchors = {}) {
  const project = projectOps.createProject({ projectId: randomUUID(), groupingSetId: schema.grouping_set_id });
  const typeId = type => schema.groups.find(group => group.type === type)?.group_id || "";
  return { ...project, groups: structuredClone(schema.groups),
    iv_group_id: anchors.ivId || typeId("iv"), dv_group_id: anchors.dvId || typeId("dv"),
    instrument_group_id: anchors.instrumentId || typeId("instrument") || null,
    link_decisions: structuredClone(schema.link_decisions || {}),
    finding_decisions: structuredClone(schema.finding_decisions || {}),
    confounder_statuses: structuredClone(schema.confounder_statuses || {}),
    rejected_variables: structuredClone(schema.rejected_variables || []) };
}

export class EchoAgentSession {
  constructor(record, home = agentHome()) {
    this.record = record;
    this.home = home;
    this.evidence = localEvidence(join(home, "snapshots", record.snapshotId));
  }

  static async start({ publicationId = DEFAULT_SCHEMA_PUBLICATION_ID, snapshotId = "", home = agentHome(),
    sync = true, onProgress } = {}) {
    const source = sync
      ? await clonePublication({ publicationId, snapshotId, home, onProgress })
      : await openLocalPublication(publicationId, home);
    if (snapshotId && source.snapshotId !== snapshotId) throw new Error("Local snapshot does not match selection.");
    const record = { id: randomUUID(), status: "editing", revision: 0,
      sourcePublication: source.publication, snapshotId: source.snapshotId,
      baseSchema: source.schema, schema: structuredClone(source.schema),
      anchors: {}, operations: [], createdAt: new Date().toISOString() };
    const session = new EchoAgentSession(record, home);
    await session.save();
    return session;
  }

  static async open(id, home = agentHome()) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid session ID.");
    return new EchoAgentSession(JSON.parse(await readFile(join(home, "sessions", `${id}.json`), "utf8")), home);
  }

  get schema() { return this.record.schema; }
  get project() { return projectFromSchema(this.schema, this.record.anchors); }
  get status() { return this.record.status; }
  publishedSplitClient() {
    return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, detectSessionInUrl: false },
    });
  }
  async browseSplits({ sourceGroupIds }) {
    const ids = [...new Set(sourceGroupIds || [])];
    if (!ids.length || ids.some(id => !ownGroup(this.schema, id))) {
      throw new Error("Choose existing source groups before browsing published splits.");
    }
    const client = this.publishedSplitClient();
    if (process.env.ECHO_SUPABASE_ACCESS_TOKEN && process.env.ECHO_SUPABASE_REFRESH_TOKEN) {
      const { error } = await client.auth.setSession({ access_token: process.env.ECHO_SUPABASE_ACCESS_TOKEN,
        refresh_token: process.env.ECHO_SUPABASE_REFRESH_TOKEN });
      if (error) throw error;
    }
    return browsePublishedSplits(ids, client);
  }
  async applyPublishedSplit({ sourceGroupIds, publicationId, groupId, newGroupId, residualLabels,
    role = "candidate", edit = false }) {
    if (!publicationId || !groupId) throw new Error("Choose a published split by publication and group ID.");
    const rows = await this.browseSplits({ sourceGroupIds });
    const row = rows.find(candidate => candidate.publication_id === publicationId && candidate.group_id === groupId);
    if (!row) throw new Error("The selected approved split is not available for these source groups.");
    const ids = await loadPublishedSplitMembership(row, this.publishedSplitClient(), this.publishedSplitFetch || fetch);
    const sources = sourceGroupIds.map(id => ownGroup(this.schema, id));
    const eligible = new Set(sources.flatMap(group => group.variable_ids));
    if (!ids.length || ids.some(id => !eligible.has(id))
      || sources.some(group => group.variable_ids.every(id => ids.includes(id)))) {
      throw new Error("This published split does not fit the current source assignments.");
    }
    return this.split({ sourceGroupIds, newGroupId, newLabel: row.name,
      newDescription: row.description, residualLabels, newVariableIds: ids,
      role, edit, splitId: row.split_id });
  }
  async save() {
    const path = join(this.home, "sessions", `${this.record.id}.json`);
    await mkdir(join(this.home, "sessions"), { recursive: true });
    const temporary = `${path}.part-${process.pid}`;
    await writeFile(temporary, JSON.stringify(this.record, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  }
  summary() {
    return { sessionId: this.record.id, status: this.status, revision: this.record.revision,
      sourcePublicationId: this.record.sourcePublication.id, snapshotId: this.record.snapshotId,
      groups: this.schema.groups.length, operations: this.record.operations.length,
      anchors: this.record.anchors, publication: this.record.published || null };
  }
  async mutate(name, args, operation) {
    if (this.status !== "editing") throw new Error(`Session is ${this.status}; start a new session to edit.`);
    const original = this.record.schema;
    const next = structuredClone(original);
    await operation(next);
    // Project operations can leave optional properties undefined. Echo's
    // persisted schema is JSON, so remove those before schema validation.
    const canonicalNext = JSON.parse(JSON.stringify(next));
    validateGroupingSchema(canonicalNext);
    this.record.schema = canonicalNext;
    this.record.revision += 1;
    this.record.operations.push({ name, args, at: new Date().toISOString() });
    await this.save();
    return this.summary();
  }
  async upsertGroup({ groupId, label, description = "", type = "candidate" }) {
    if (!groupId || !String(label || "").trim()) throw new Error("Group ID and label are required.");
    return this.mutate("upsert_group", { groupId, label, description, type }, schema => {
      const project = projectFromSchema(schema, this.record.anchors);
      const existing = ownGroup(schema, groupId);
      const group = { ...(existing || { group_id: groupId, variable_ids: [], source: "agent" }),
        label: label.trim(), description: description.trim(), type };
      schema.groups = projectOps.upsertGroup(project, group, new Date().toISOString()).groups;
    });
  }
  async assignVariables({ groupId, variableIds }) {
    if (!ownGroup(this.schema, groupId)) throw new Error("Unknown group.");
    const ids = [...new Set(variableIds || [])];
    const rows = await this.evidence.variables(ids);
    if (rows.length !== ids.length) throw new Error("One or more variable IDs are absent from the pinned evidence snapshot.");
    const canonicalIds = [...new Set(rows.map(row => row.canonical_variable_id || row.variable_id))];
    return this.mutate("assign_variables", { groupId, variableIds: ids }, schema => {
      const project = projectFromSchema(schema, this.record.anchors);
      schema.groups = projectOps.addMembers(project, groupId, canonicalIds, new Date().toISOString()).groups;
    });
  }
  async removeVariables({ groupId, variableIds }) {
    if (!ownGroup(this.schema, groupId)) throw new Error("Unknown group.");
    return this.mutate("remove_variables", { groupId, variableIds }, schema => {
      schema.groups = projectOps.removeMembers(projectFromSchema(schema), groupId, variableIds, new Date().toISOString()).groups;
    });
  }
  async split({ sourceGroupIds, newGroupId, newLabel, newDescription = "", residualLabels,
    newVariableIds, role = "candidate", splitId = null, edit = false }) {
    if ([...String(newDescription).trim()].length < 20) {
      throw new Error("Split descriptions must be at least 20 characters.");
    }
    let nextAnchors = null;
    await this.mutate(edit ? "edit_split" : "split", { sourceGroupIds, newGroupId, newLabel, newDescription,
      residualLabels, newVariableIds, role, splitId }, schema => {
      const operation = edit ? projectOps.updateSplitCategories : projectOps.splitCategories;
      const next = operation(projectFromSchema(schema, this.record.anchors), {
        sourceGroupIds, newGroupId, newLabel, newDescription, residualLabels,
        newVariableIds, role, splitId, timestamp: new Date().toISOString(),
      });
      schema.groups = next.groups;
      nextAnchors = { ...this.record.anchors };
      if (next.iv_group_id === newGroupId) nextAnchors.ivId = newGroupId;
      if (next.dv_group_id === newGroupId) nextAnchors.dvId = newGroupId;
      if (next.instrument_group_id === newGroupId) nextAnchors.instrumentId = newGroupId;
    });
    this.record.anchors = nextAnchors;
    await this.save();
    return this.summary();
  }
  async rejectVariables({ variableIds, reason = "low_quality" }) {
    const ids = [...new Set(variableIds || [])];
    const rows = await this.evidence.variables(ids);
    if (rows.length !== ids.length) throw new Error("One or more variable IDs are absent from the pinned evidence snapshot.");
    const canonicalIds = [...new Set(rows.map(row => row.canonical_variable_id || row.variable_id))];
    const labelById = new Map(rows.map(row => [row.canonical_variable_id || row.variable_id,
      row.display_label || row.concept_label || ""]));
    return this.mutate("reject_variables", { variableIds: ids, reason }, schema => {
      const project = projectFromSchema(schema);
      const entries = canonicalIds.map(id => ({ variable_id: id, member_variable_ids: [id], label: labelById.get(id),
        reason, flagged_at: new Date().toISOString(), previous_group_ids: schema.groups
          .filter(group => group.variable_ids.includes(id)).map(group => group.group_id) }));
      const next = visibility.rejectVariables(project, entries, new Map(), new Map());
      schema.rejected_variables = next.rejected_variables;
      schema.groups = projectOps.removeMembersEverywhere(next, canonicalIds).groups;
      schema.hidden_variable_ids = [...new Set([...(schema.hidden_variable_ids || []), ...canonicalIds])].sort();
    });
  }
  async restoreVariables({ variableIds }) {
    const ids = [...new Set(variableIds || [])];
    return this.mutate("restore_variables", { variableIds: ids }, schema => {
      let project = projectFromSchema(schema);
      for (const id of ids) project = visibility.restoreRejection(project, id, new Map(), new Map());
      schema.rejected_variables = project.rejected_variables;
      schema.hidden_variable_ids = (schema.hidden_variable_ids || []).filter(id => !ids.includes(id));
    });
  }
  async setAnchors({ ivId, dvId, instrumentId = null }) {
    const ids = [ivId, dvId, instrumentId].filter(Boolean);
    if (ids.some(id => !ownGroup(this.schema, id)) || !ivId || !dvId || ivId === dvId) {
      throw new Error("Choose distinct existing IV and DV groups and an optional distinct instrument.");
    }
    if (instrumentId && (instrumentId === ivId || instrumentId === dvId)) throw new Error("Instrument must be distinct.");
    await this.mutate("set_anchors", { ivId, dvId, instrumentId }, schema => {
      let project = projectFromSchema(schema, this.record.anchors);
      const timestamp = new Date().toISOString();
      project = projectOps.promoteAnchor(project, "iv", ivId, timestamp);
      project = projectOps.promoteAnchor(project, "dv", dvId, timestamp);
      schema.groups = project.groups;
    });
    this.record.anchors = { ivId, dvId, instrumentId };
    await this.save();
    return this.summary();
  }
  async setEdgeDecision({ edgeId, excluded, reason = "" }) {
    const graph = await this.graph();
    if (!graph.dag.edges.some(edge => edge.edge_id === edgeId)) throw new Error("Unknown graph edge.");
    return this.mutate("set_edge_decision", { edgeId, excluded, reason }, schema => {
      const project = projectFromSchema(schema);
      schema.link_decisions = projectOps.setLinkDecision(project, edgeId,
        excluded ? { display_status: "excluded", ...(reason ? { exclude_reason: reason } : {}) } : null).link_decisions;
    });
  }
  async setFindingDecision({ rawLinkId, excluded, reasonCode = "", reasonText = "" }) {
    if (!(await this.evidence.rawLinks([rawLinkId])).length) throw new Error("Unknown finding ID.");
    if (!excluded && reasonCode) throw new Error("Reason codes apply only to excluded findings.");
    return this.mutate("set_finding_decision", { rawLinkId, excluded, reasonCode, reasonText }, schema => {
      const project = projectFromSchema(schema);
      schema.finding_decisions = projectOps.setFindingDecision(project, rawLinkId,
        excluded ? { display_status: "excluded", ...(reasonCode ? { reason_code: reasonCode } : {}),
          ...(reasonText ? { reason_text: reasonText } : {}) } : null).finding_decisions;
      schema.finding_reviews ||= {};
      if (excluded || !reasonText.trim()) delete schema.finding_reviews[rawLinkId];
      else schema.finding_reviews[rawLinkId] = { status: "retained", reason_text: reasonText };
    });
  }
  async setConfounderStatus({ groupId, status, text = "" }) {
    const { ivId, dvId } = this.record.anchors;
    if (!ivId || !dvId || !ownGroup(this.schema, groupId)) throw new Error("Choose anchors and an existing group first.");
    return this.mutate("set_confounder_status", { groupId, status, text }, schema => {
      schema.confounder_statuses ||= {};
      schema.confounder_statuses[confounderKey(ivId, dvId, groupId)] = { status, ...(text ? { text } : {}) };
    });
  }
  async jevClassify(phase, { sourceGroupIds, description, useAIWhenPublishedAvailable = false }) {
    if (this.status !== "editing") throw new Error("Session is not editable.");
    const sourceIds = [...new Set(sourceGroupIds || [])];
    const groups = sourceIds.map(id => ownGroup(this.schema, id));
    if (!sourceIds.length || groups.some(group => !group)) throw new Error("Choose existing source groups.");
    const eligible = [...new Set(groups.flatMap(group => group.variable_ids))];
    if (!eligible.length || !String(description || "").trim()) throw new Error("Source variables and a target definition are required.");
    let publishedSplitLookup = null;
    if (phase === "test") {
      try {
        const candidates = await this.browseSplits({ sourceGroupIds: sourceIds });
        publishedSplitLookup = { status: "ok", candidates };
        if (candidates.length && !useAIWhenPublishedAvailable) {
          return { phase: "published_lookup", candidates,
            next: "Review these approved splits. Apply one with echo_apply_published_split, or call echo_jev_test with useAIWhenPublishedAvailable: true if none fits the intended definition." };
        }
      } catch (error) {
        publishedSplitLookup = { status: "unavailable", error: String(error?.message || error) };
      }
    }
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("Set OPENROUTER_API_KEY outside the repository.");
    const problem = cappedKeyStatus((await openRouterJson("/api/v1/key", key)).data);
    if (problem) throw new Error(problem);
    const previous = this.record.jev;
    const sameSource = previous && JSON.stringify(previous.sourceGroupIds) === JSON.stringify(sourceIds)
      && JSON.stringify(previous.eligible) === JSON.stringify(eligible);
    if (phase === "full" && (!sameSource || previous.description !== description || !previous.testComplete)) {
      throw new Error("Run the Jev test on this definition first.");
    }
    if (phase === "test" && (!sameSource || previous.description !== description)) {
      this.record.jev = { sourceGroupIds: sourceIds, eligible, description,
        sample: sameSource ? previous.sample : randomSampleIds(eligible, JEV_TEST_SIZE),
        test: [], full: [], testComplete: false, fullComplete: false };
      await this.save();
    }
    const run = this.record.jev;
    const sample = new Set(run.sample);
    const ids = phase === "test" ? run.sample : eligible.filter(id => !sample.has(id));
    const done = new Map((run[phase] || []).map(row => [row.id, row]));
    for (let offset = 0; offset < ids.length; offset += JEV_BATCH_SIZE) {
      const batchIds = ids.slice(offset, offset + JEV_BATCH_SIZE);
      if (batchIds.every(id => done.has(id))) continue;
      const variables = await this.evidence.variables(batchIds);
      const byId = new Map(variables.map(variable => [variable.variable_id, variable]));
      const records = jevRecords(batchIds, id => byId.get(id));
      const response = await openRouterJson("/api/alpha/decisions", key, {
        method: "POST", body: JSON.stringify(jevRequest(records, description)),
      });
      const results = jevResults(response, records);
      for (const row of results) done.set(row.id, row);
      run[phase] = ids.filter(id => done.has(id)).map(id => done.get(id));
      await this.save();
    }
    run[`${phase}Complete`] = true;
    await this.save();
    return { phase, results: run[phase], fullCount: eligible.length, completed: run[phase].length,
      ...(publishedSplitLookup ? { publishedSplitLookup } : {}) };
  }
  async jevOverride({ variableId, side }) {
    const run = this.record.jev;
    if (!run?.fullComplete || !["new", "leftover"].includes(side)) throw new Error("Run the full split before reviewing choices.");
    const row = [...run.test, ...run.full].find(item => item.id === variableId);
    if (!row) throw new Error("Variable is not in this Jev run.");
    row.side = side;
    await this.save();
    return { variableId, side };
  }
  async jevEstimate({ sourceGroupIds, description, useAIWhenPublishedAvailable = false }) {
    if (this.status !== "editing") throw new Error("Session is not editable.");
    const sourceIds = [...new Set(sourceGroupIds || [])];
    const groups = sourceIds.map(id => ownGroup(this.schema, id));
    if (!groups.length || groups.some(group => !group)) throw new Error("Choose existing source groups.");
    if (!String(description || "").trim()) throw new Error("Provide a target definition.");
    let publishedSplitLookup;
    try {
      const candidates = await this.browseSplits({ sourceGroupIds: sourceIds });
      publishedSplitLookup = { status: "ok", candidates };
      if (candidates.length && !useAIWhenPublishedAvailable) {
        return { phase: "published_lookup", candidates,
          next: "Review these approved splits. Apply one with echo_apply_published_split, or repeat with useAIWhenPublishedAvailable: true if none fits." };
      }
    } catch (error) {
      publishedSplitLookup = { status: "unavailable", error: String(error?.message || error) };
    }
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("Set OPENROUTER_API_KEY outside the repository.");
    const problem = cappedKeyStatus((await openRouterJson("/api/v1/key", key)).data);
    if (problem) throw new Error(problem);
    const model = await openRouterJson("/api/v1/model/typesafe/jev-1.13", key);
    const pricing = parseJevPricing(model.data?.pricing);
    if (!pricing) throw new Error("Jev pricing is unavailable.");
    const ids = [...new Set(groups.flatMap(group => group.variable_ids))];
    const variables = await this.evidence.variables(ids);
    const byId = new Map(variables.map(variable => [variable.variable_id, variable]));
    const prior = this.record.jev;
    const sampleIds = prior && JSON.stringify(prior.eligible) === JSON.stringify(ids)
      ? prior.sample : randomSampleIds(ids, JEV_TEST_SIZE);
    if (!prior || JSON.stringify(prior.eligible) !== JSON.stringify(ids) || prior.description !== description) {
      this.record.jev = { sourceGroupIds: [...new Set(sourceGroupIds)], eligible: ids, description,
        sample: sampleIds, test: [], full: [], testComplete: false, fullComplete: false };
      await this.save();
    }
    const records = jevRecords(ids, id => byId.get(id));
    const sample = jevRecords(sampleIds, id => byId.get(id));
    const test = jevRequestSizes(sample, description);
    const full = jevRequestSizes(records, description);
    return { variables: records.length, testVariables: sample.length,
      estimatedTestUsd: estimatedJevCharge(test, pricing), estimatedFullUsd: estimatedJevCharge(full, pricing),
      model: "typesafe/jev-1.13", publishedSplitLookup };
  }
  async jevApplySplit({ newGroupId, newLabel, newDescription = "", residualLabels, role = "candidate", edit = false, splitId = null }) {
    const run = this.record.jev;
    if (!run?.fullComplete) throw new Error("Run and review the full Jev split first.");
    const chosen = [...run.test, ...run.full].filter(row => row.side === "new").map(row => row.id);
    const result = await this.split({ sourceGroupIds: run.sourceGroupIds, newGroupId, newLabel, newDescription,
      residualLabels, newVariableIds: chosen, role, edit, splitId });
    this.record.jev = null;
    await this.save();
    return result;
  }
  async graph(options = {}) {
    const rawLinks = await this.evidence.rawLinks();
    const project = projectFromSchema(this.schema, this.record.anchors);
    const dag = fullCompileDag({ schema: this.schema, project, rawLinks });
    const view = deriveDagView({ groups: this.schema.groups, links: dag.edges,
      ivId: project.iv_group_id, dvId: project.dv_group_id, instrumentId: project.instrument_group_id,
      ...options });
    return jsonSafe({ dag, view });
  }
  async candidates() {
    return buildCandidateQueue(projectFromSchema(this.schema, this.record.anchors),
      await this.evidence.candidateInputs());
  }
  async groupNeighbors({ groupId, limit = 40 }) {
    const group = ownGroup(this.schema, groupId);
    if (!group) throw new Error("Unknown group.");
    const neighbors = await this.evidence.neighbors(group.variable_ids);
    const ids = [...new Set([...group.variable_ids, ...neighbors.map(row => row.neighbor_variable_id)])];
    const variableById = new Map((await this.evidence.variables(ids)).map(row => [row.variable_id, row]));
    for (const id of group.variable_ids) {
      const variable = variableById.get(id);
      if (variable) variable.similarity_neighbors = neighbors.filter(row => row.variable_id === id)
        .map(row => ({ variable_id: row.neighbor_variable_id, llm_rank: row.llm_rank,
          cosine_similarity: row.cosine_similarity }));
    }
    const blockedIds = new Set(this.schema.groups.filter(candidate => candidate.group_id !== groupId)
      .flatMap(candidate => candidate.variable_ids));
    return groupNeighborSuggestions(group, { variableById, blockedIds, clusterMemberIds: id => [id],
      rejectedIds: new Set(this.schema.hidden_variable_ids || []), selectedUoa: null,
      uoaFilterEnabled: false, uoaMatches: () => true }, Math.max(1, Math.min(200, Number(limit) || 40)));
  }
  async diff() {
    const before = new Map(this.record.baseSchema.groups.map(group => [group.group_id, group]));
    const after = new Map(this.schema.groups.map(group => [group.group_id, group]));
    const changedGroups = [...after].filter(([id, group]) => JSON.stringify(group) !== JSON.stringify(before.get(id)))
      .map(([id]) => id);
    const canonical = await canonicalizeWorkingSchema(this.schema);
    return { ...this.summary(), contentHash: canonical.contentHash,
      changedGroups, removedGroups: [...before.keys()].filter(id => !after.has(id)),
      findingDecisions: Object.keys(this.schema.finding_decisions || {}).length,
      edgeDecisions: Object.keys(this.schema.link_decisions || {}).length,
      rejectedVariables: (this.schema.rejected_variables || []).length };
  }
  async ready() {
    if (this.status !== "editing") throw new Error("Session is not editable.");
    validateGroupingSchema(this.schema);
    const emptyGroups = this.schema.groups.filter(group => !group.variable_ids.length).map(group => group.group_id);
    if (emptyGroups.length) throw new Error(`Remove empty groups before publication: ${emptyGroups.join(", ")}`);
    const rawLinks = await this.evidence.rawLinks();
    fullCompileDag({ schema: this.schema, project: projectFromSchema(this.schema, this.record.anchors), rawLinks });
    const diff = await this.diff();
    if (diff.contentHash === this.record.sourcePublication.content_hash) {
      throw new Error("Working schema already matches the starting publication.");
    }
    this.record.readyHash = diff.contentHash;
    this.record.status = "ready";
    await this.save();
    return { ...diff, status: "ready" };
  }
  async publish({ maxPathLength = 1, showConfoundersOnly = true } = {}) {
    if (this.status !== "ready") throw new Error("Review and mark this session ready before publishing.");
    if (!Number.isInteger(maxPathLength) || maxPathLength < 1 || maxPathLength > 99) {
      throw new Error("Permalink path length must be an integer from 1 to 99.");
    }
    if (typeof showConfoundersOnly !== "boolean") throw new Error("Invalid permalink confounder view option.");
    const current = await canonicalizeWorkingSchema(this.schema);
    if (current.contentHash !== this.record.readyHash) throw new Error("Schema changed after review.");
    const variableLayoutSource = await this.evidence.layoutSource();
    const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, detectSessionInUrl: false },
    });
    if (process.env.ECHO_SUPABASE_ACCESS_TOKEN && process.env.ECHO_SUPABASE_REFRESH_TOKEN) {
      const { error } = await client.auth.setSession({ access_token: process.env.ECHO_SUPABASE_ACCESS_TOKEN,
        refresh_token: process.env.ECHO_SUPABASE_REFRESH_TOKEN });
      if (error) throw error;
    }
    const rawLinks = await this.evidence.rawLinks();
    this.record.status = "publishing";
    await this.save();
    try {
      const result = await publishWorkingSchema({ schema: this.schema, client,
        previousPublication: { publication_id: this.record.sourcePublication.id },
        compileInput: { project: projectFromSchema(this.schema, this.record.anchors), rawLinks } });
      this.record.status = "published";
      const state = { project: this.project, data: { snapshot: { snapshot_id: this.record.snapshotId } },
        workflowMode: "dag", variableLayoutSource,
        confounderMaxPathLength: maxPathLength, showConfoundersOnly };
      this.record.published = { publicationId: result.publicationId, contentHash: result.contentHash,
        permalink: publicationPermalink(result.publicationId, undefined, state), reused: result.reused };
      await this.save();
      return this.record.published;
    } catch (error) {
      this.record.status = "publish_failed";
      this.record.publishError = String(error?.message || error);
      await this.save();
      throw error;
    }
  }
}
