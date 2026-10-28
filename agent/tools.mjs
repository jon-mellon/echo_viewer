import { EchoAgentSession } from "./session.mjs";
import { clonePublication } from "./local_data.mjs";

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = { type: "string" }, bool = { type: "boolean" }, num = { type: "number" };
const strings = { type: "array", items: str };
const define = (name, description, inputSchema, run) => ({ name, description, inputSchema, run });

export function createEchoTools({ getSession, setSession }) {
  const session = () => {
    const current = getSession();
    if (!current) throw new Error("Start or resume a session first.");
    return current;
  };
  return [
    define("echo_clone", "Clone and verify a published schema and its pinned evidence snapshot locally.",
      obj({ publicationId: str, snapshotId: str }), async a => {
        const result = await clonePublication(a);
        return { publicationId: result.publication.id, snapshotId: result.snapshotId,
          groupCount: result.schema.groups.length };
      }),
    define("echo_start", "Start a local working session. Defaults to the combined 100k + socsci publication and snapshot the Echo UI uses; optionally choose a publication and compatible evidence snapshot.",
      obj({ publicationId: str, snapshotId: str, sync: bool }), async a => {
        const value = await EchoAgentSession.start(a);
        setSession(value);
        return value.summary();
      }),
    define("echo_resume", "Resume a locally saved agent session by ID.",
      obj({ sessionId: str }, ["sessionId"]), async a => {
        const value = await EchoAgentSession.open(a.sessionId);
        setSession(value);
        return value.summary();
      }),
    define("echo_status", "Inspect current session status and selected publication.", obj({}), async () => session().summary()),
    define("echo_groups", "List the working schema's groups and members.", obj({ groupId: str }), async a => {
      const groups = session().schema.groups;
      return a.groupId ? groups.find(group => group.group_id === a.groupId) || null
        : groups.map(({ group_id, label, description, type, variable_ids }) => ({ group_id, label, description, type,
          member_count: variable_ids.length }));
    }),
    define("echo_schema", "Inspect the complete local working schema, including unpublished explanations.",
      obj({}), async () => session().schema),
    define("echo_search_variables", "Search variable occurrences in the local pinned snapshot.",
      obj({ query: str, limit: num }, ["query"]), async a =>
        (await session().evidence.searchVariables(a.query, a.limit)).map(row => ({
          variable_id: row.variable_id, canonical_variable_id: row.canonical_variable_id,
          display_label: row.display_label, concept_label: row.concept_label,
          raw_variable_text: row.raw_variable_text, uoa: row.uoa, paper_id: row.paper_id,
        }))),
    define("echo_variables", "Inspect variable occurrences by ID from the local snapshot.",
      obj({ variableIds: strings }, ["variableIds"]), async a => session().evidence.variables(a.variableIds)),
    define("echo_neighbors", "Inspect local neighbor suggestions for variable IDs.",
      obj({ variableIds: strings }, ["variableIds"]), async a => session().evidence.neighbors(a.variableIds)),
    define("echo_group_neighbors", "Rank unassigned neighbor suggestions for a group with Echo's selection rules.",
      obj({ groupId: str, limit: num }, ["groupId"]), a => session().groupNeighbors(a)),
    define("echo_findings", "Inspect raw finding evidence locally by finding IDs or incident variable IDs.",
      obj({ rawLinkIds: strings, variableIds: strings, limit: num }), async a => {
        const rows = a.rawLinkIds ? await session().evidence.rawLinks(a.rawLinkIds)
          : a.variableIds ? await session().evidence.incidentLinks(a.variableIds)
            : await session().evidence.rawLinks(null, a.limit || 100);
        return rows.slice(0, Math.max(1, Math.min(500, a.limit || 100)));
      }),
    define("echo_upsert_group", "Create or edit a schema group using Echo's project operation.",
      obj({ groupId: str, label: str, description: str, type: str }, ["groupId", "label"]), a => session().upsertGroup(a)),
    define("echo_assign_variables", "Assign variables to a group using Echo's membership operation.",
      obj({ groupId: str, variableIds: strings }, ["groupId", "variableIds"]), a => session().assignVariables(a)),
    define("echo_remove_variables", "Remove variables from a group using Echo's membership operation.",
      obj({ groupId: str, variableIds: strings }, ["groupId", "variableIds"]), a => session().removeVariables(a)),
    define("echo_split", "Create or edit a variable split with Echo's exact split validation and provenance.",
      obj({ sourceGroupIds: strings, newGroupId: str, newLabel: str, newDescription: str,
        residualLabels: { type: "object" }, newVariableIds: strings, role: str, splitId: str, edit: bool },
      ["sourceGroupIds", "newGroupId", "newLabel", "newDescription", "residualLabels", "newVariableIds"]), a => session().split(a)),
    define("echo_browse_published_splits", "Find approved published splits for exact source groups. Review their names and descriptions before using Jev to classify a new split.",
      obj({ sourceGroupIds: strings }, ["sourceGroupIds"]), a => session().browseSplits(a)),
    define("echo_apply_published_split", "Apply a chosen approved split after verifying its published membership file against the current source assignments.",
      obj({ sourceGroupIds: strings, publicationId: str, groupId: str, newGroupId: str,
        residualLabels: { type: "object" }, role: str, edit: bool },
      ["sourceGroupIds", "publicationId", "groupId", "newGroupId", "residualLabels"]),
      a => session().applyPublishedSplit(a)),
    define("echo_reject_variables", "Reject variables in the working schema using Echo's rejection policy.",
      obj({ variableIds: strings, reason: str }, ["variableIds"]), a => session().rejectVariables(a)),
    define("echo_restore_variables", "Restore rejected variables in the working schema.",
      obj({ variableIds: strings }, ["variableIds"]), a => session().restoreVariables(a)),
    define("echo_set_anchors", "Select IV, DV, and optional instrument for graph diagnostics.",
      obj({ ivId: str, dvId: str, instrumentId: str }, ["ivId", "dvId"]), a => session().setAnchors(a)),
    define("echo_set_edge_decision", "Exclude or restore a graph edge.",
      obj({ edgeId: str, excluded: bool, reason: str }, ["edgeId", "excluded"]), a => session().setEdgeDecision(a)),
    define("echo_set_finding_decision", "Exclude a finding with a reason, or retain it with a private open review reason.",
      obj({ rawLinkId: str, excluded: bool, reasonCode: str, reasonText: str }, ["rawLinkId", "excluded"]),
      a => session().setFindingDecision(a)),
    define("echo_set_confounder_status", "Set Echo's status for a potential confounder and a private open reason under the selected IV and DV.",
      obj({ groupId: str, status: str, text: str }, ["groupId", "status"]), a => session().setConfounderStatus(a)),
    define("echo_graph", "Compile the working DAG and calculate Echo's confounder, collider, and exclusion diagnostics.",
      obj({ showConfoundersOnly: bool, showCollidersOnly: bool, showExclusionViolations: bool,
        showExogeneity: bool, maxPathLength: num, excludeBottlenecked: bool,
        hideIrrelevantDiagnosticLinks: bool, includeDag: bool }), async a => {
        const { includeDag, ...options } = a;
        const result = await session().graph(options);
        return includeDag ? result : { view: result.view,
          nodes: result.dag.nodes.length, edges: result.dag.edges.length };
      }),
    define("echo_candidates", "Rank candidate groups with Echo's causal and map-region queue.",
      obj({}), () => session().candidates()),
    define("echo_jev_test", "First look for approved published splits. If any exist, review them and apply one, or explicitly choose AI classification; then test on Echo's 24-variable Jev sample.",
      obj({ sourceGroupIds: strings, description: str, useAIWhenPublishedAvailable: bool }, ["sourceGroupIds", "description"]),
      a => session().jevClassify("test", a)),
    define("echo_jev_estimate", "Look for approved published splits first; if none fits, estimate Jev test and full-run charges before classification.",
      obj({ sourceGroupIds: strings, description: str, useAIWhenPublishedAvailable: bool }, ["sourceGroupIds", "description"]),
      a => session().jevEstimate(a)),
    define("echo_jev_full", "Classify remaining source variables with the same Jev model and request format Echo uses.",
      obj({ sourceGroupIds: strings, description: str }, ["sourceGroupIds", "description"]),
      a => session().jevClassify("full", a)),
    define("echo_jev_override", "Correct one full-run Jev suggestion before applying it.",
      obj({ variableId: str, side: { type: "string", enum: ["new", "leftover"] } }, ["variableId", "side"]),
      a => session().jevOverride(a)),
    define("echo_jev_apply_split", "Apply reviewed full Jev suggestions through Echo's split operation.",
      obj({ newGroupId: str, newLabel: str, newDescription: str, residualLabels: { type: "object" },
        role: str, edit: bool, splitId: str }, ["newGroupId", "newLabel", "newDescription", "residualLabels"]),
      a => session().jevApplySplit(a)),
    define("echo_diff", "Show the working schema's changes and canonical public content hash.", obj({}), () => session().diff()),
    define("echo_ready", "Validate the complete schema and freeze it for a single final publication action.", obj({}), () => session().ready()),
    define("echo_publish", "Publish once through Echo's normal Supabase Storage and registry path and return a view permalink. This is public and immutable.",
      obj({ maxPathLength: num, showConfoundersOnly: bool }), a => session().publish(a)),
  ];
}
