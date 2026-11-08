// Switching grouping set (replaceSchemaGroups) is not recorded in undo history, and the
// snapshot format has no grouping-set identity, so a later undo restores the old set's groups.
import * as P from "../../site/dag_project.mjs";
import * as H from "../../site/project_history.mjs";
import { initial, clusterOf, clusterMembers } from "./sequence_fuzz.mjs";

const app = { project: initial(), phase: "build", undoHistory: [], undoPointer: -1, actionLog: [] };
const snap = () => P.snapshotProject(app.project, app.phase);
function commit(desc, fn) { const b = snap(); fn(); Object.assign(app, H.recordHistory(app, desc, b, snap(), "t") || {}); }
const show = l => console.log(l.padEnd(26), "set=" + app.project.active_grouping_set_id,
  "iv=" + app.project.iv_group_id, "groups=" + app.project.groups.map(g => g.group_id).join(","));

commit("rename a", () => { app.project = P.updateGroup(app.project, "a", { label: "Renamed A" }); });
show("start (set gs)");
const other = { grouping_set_id: "gs2", groups: [
  { group_id: "x1", label: "X1", variable_ids: ["v0", "v1", "v3"] }, { group_id: "x2", label: "X2", variable_ids: ["v2", "v8"] } ] };
app.project = P.replaceSchemaGroups(app.project, other, clusterOf, clusterMembers); // not recorded by the app
show("after switch to gs2");
const s = H.historyStep(app, "undo"); app.undoPointer = s.undoPointer;
app.project = P.restoreSnapshot(app.project, s.snapshot).project;
show("after Undo (rename a)");
