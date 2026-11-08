// Minimal repros for anchor-id bugs around undo/redo and split roles.
import * as P from "../../site/dag_project.mjs";
import * as H from "../../site/project_history.mjs";
import { initial } from "./sequence_fuzz.mjs";

function app() { return { project: initial(), phase: "build", undoHistory: [], undoPointer: -1, actionLog: [] }; }
function commit(a, desc, kind, fn) {
  const snap = () => kind === "anchors" ? P.snapshotAnchors(a.project, a.phase) : P.snapshotProject(a.project, a.phase);
  const before = snap(); fn(); Object.assign(a, H.recordHistory(a, desc, before, snap(), "t", kind === "anchors" ? "anchors" : "full") || {});
}
function step(a, dir) {
  const s = H.historyStep(a, dir); a.undoPointer = s.undoPointer;
  const r = P.restoreSnapshot(a.project, s.snapshot); a.project = r.project; a.phase = r.phase;
}
const show = (label, a) => console.log(label.padEnd(34), "iv=" + JSON.stringify(a.project.iv_group_id), "dv=" + JSON.stringify(a.project.dv_group_id),
  "groups=" + a.project.groups.map(g => g.group_id + (g.type ? `:${g.type}` : "")).join(","));

// R1: clear cause, make a custom variable the cause, undo.
let a = app();
commit(a, "clear iv", "anchors", () => { a.project = P.clearAnchor(a.project, "iv"); });
commit(a, "split role=iv", "full", () => { a.project = P.splitCategories(a.project, { sourceGroupIds: ["a"], newGroupId: "s0", newLabel: "S", residualLabels: { a: "A rest" }, newVariableIds: ["v3"], timestamp: "t", role: "iv" }); });
show("R1 after split", a);
step(a, "undo");
show("R1 after undo (expect iv='')", a);

// R2: redo of delete-custom-variable.
a = app();
commit(a, "split role=iv", "full", () => { a.project = P.splitCategories(a.project, { sourceGroupIds: ["a"], newGroupId: "s0", newLabel: "S", residualLabels: { a: "A rest" }, newVariableIds: ["v3"], timestamp: "t", role: "iv" }); });
commit(a, "delete s0", "full", () => { a.project = P.deleteSplitCategories(a.project, { groupId: "s0", timestamp: "t" }); });
show("R2 after delete", a);
step(a, "undo"); show("R2 after undo", a);
step(a, "redo"); show("R2 after redo (expect iv null)", a);

// R3: split with role iv while a different group is the cause.
a = app();
commit(a, "split role=iv", "full", () => { a.project = P.splitCategories(a.project, { sourceGroupIds: ["b"], newGroupId: "s0", newLabel: "S", residualLabels: { b: "B rest" }, newVariableIds: ["v8"], timestamp: "t", role: "iv" }); });
show("R3 after split (g_iv should lose type)", a);
