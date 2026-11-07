import test from "node:test";
import assert from "node:assert/strict";
import * as P from "../site/dag_project.mjs";
import * as H from "../site/project_history.mjs";
import { initial, clusterOf, clusterMembers, check } from "./audit/sequence_fuzz.mjs";

function makeApp() { return { project: initial(), phase: "build", undoHistory: [], undoPointer: -1, actionLog: [] }; }
function commit(app, kind, fn) {
  const snap = () => kind === "anchors" ? P.snapshotAnchors(app.project, app.phase) : P.snapshotProject(app.project, app.phase);
  const before = snap(); fn();
  Object.assign(app, H.recordHistory(app, "x", before, snap(), "t", kind === "anchors" ? "anchors" : "full") || {});
}
function step(app, dir) {
  const s = H.historyStep(app, dir); app.undoPointer = s.undoPointer;
  app.project = P.restoreSnapshot(app.project, s.snapshot).project;
}
const split = (app, source, role) => commit(app, "full", () => {
  app.project = P.splitCategories(app.project, { sourceGroupIds: [source], newGroupId: "s0", newLabel: "S",
    residualLabels: { [source]: `${source} rest` }, newVariableIds: [app.project.groups.find(g => g.group_id === source).variable_ids[0]],
    timestamp: "t", role });
});

test("undoing a split restores an intentionally cleared cause", () => {
  const app = makeApp();
  commit(app, "anchors", () => { app.project = P.clearAnchor(app.project, "iv"); });
  split(app, "a", "iv");
  step(app, "undo");
  assert.equal(app.project.iv_group_id, "");
  assert.deepEqual(check(app), []);
});

test("redoing deletion of a custom cause clears the role", () => {
  const app = makeApp();
  split(app, "a", "iv");
  commit(app, "full", () => { app.project = P.deleteSplitCategories(app.project, { groupId: "s0", timestamp: "t" }); });
  step(app, "undo"); step(app, "redo");
  assert.equal(app.project.iv_group_id, null);
  assert.deepEqual(check(app), []);
});

test("a custom variable made the cause demotes the previous cause", () => {
  const app = makeApp();
  split(app, "b", "iv");
  assert.equal(app.project.groups.filter(g => g.type === "iv").length, 1);
  assert.deepEqual(check(app), []);
});

test("undo after switching grouping set keeps groups and set id together", () => {
  const app = makeApp();
  commit(app, "full", () => { app.project = P.updateGroup(app.project, "a", { label: "Renamed A" }); });
  app.project = P.replaceSchemaGroups(app.project, { grouping_set_id: "gs2", groups: [
    { group_id: "x1", label: "X1", variable_ids: ["v3"] }] }, clusterOf, clusterMembers);
  step(app, "undo");
  assert.equal(app.project.active_grouping_set_id, "gs");
  assert.ok(app.project.groups.some(g => g.group_id === "a"));
});
