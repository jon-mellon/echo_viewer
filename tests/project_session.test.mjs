import test from "node:test";
import assert from "node:assert/strict";
import { readProject, writeProject, restoreProjectPayload, projectStorageKey } from "../site/project_persistence.mjs";
import { recordHistory, historyStep } from "../site/project_history.mjs";

test("storage round-trip preserves settings and normalizes legacy project fields", () => {
  const data = new Map();
  const storage = { setItem: (k, v) => data.set(k, v), getItem: k => data.get(k) };
  const payload = {
    schema_version: "dag-builder-project-v1",
    groups: [{ group_id: "g", status: "rejected", variable_ids: ["a"] }],
    selectedUoa: "people", uoaFilterEnabled: false, phase: "build",
    workflowMode: "dag_review", changingAnchorSide: "iv",
    variableLayoutSource: " custom ", dagLayoutMode: "organic",
    seeds: { iv: ["a"], dv: ["b"] },
    definitionDraft: { role: "iv", step: "partition", new_variable_ids: ["a"] },
    undoHistory: [{ description: "split", before: "0", after: "1" }],
    undoPointer: 0,
    actionLog: [{ description: "split", time: "t" }],
    saved_at: "stale",
  };
  const key = projectStorageKey("prefix", { generated_at: "date" }, 2);
  assert.equal(key, "prefix:date:2:none");
  assert.equal(projectStorageKey("prefix", {
    generated_at: "changing", cache_compatibility: { record_signature: "stable" },
    default_grouping_set_id: "schema",
  }, 2), "prefix:stable:2:schema");
  assert.equal(projectStorageKey("prefix", {
    generated_at: "date", publication_source: { publication_id: "published-id" },
  }, 2), "prefix:date:2:none:published-id");
  writeProject(storage, key, payload);
  const result = restoreProjectPayload(readProject(storage, key), { links: [] }, "default");
  assert.equal(result.project.groups[0].status, undefined);
  assert.equal(payload.groups[0].status, "rejected");
  assert.equal(result.workflowMode, "group_review");
  assert.equal(result.selectedUoa, "people");
  assert.equal(result.uoaFilterEnabled, false);
  assert.equal(result.changingAnchorSide, "iv");
  assert.equal(result.variableLayoutSource, "custom");
  assert.equal(result.dagLayoutMode, "organic");
  assert.deepEqual([...result.seeds.iv], ["a"]);
  assert.deepEqual([...result.seeds.dv], ["b"]);
  assert.equal(result.definitionDraft.step, "partition");
  assert.equal(result.undoHistory.length, 1);
  assert.equal(result.undoPointer, 0);
  assert.equal(result.actionLog[0].description, "split");
  assert.deepEqual(result.project.links, []);
  assert.equal(Object.hasOwn(result.project, "schema_version"), false);
  assert.equal(Object.hasOwn(result.project, "saved_at"), false);
  assert.equal(Object.hasOwn(result.project, "selectedUoa"), false);
  assert.equal(Object.hasOwn(result.project, "undoHistory"), false);
});

test("missing, incompatible and malformed storage is explicit", () => {
  assert.equal(readProject({ getItem: () => null }, "k"), null);
  assert.equal(restoreProjectPayload({}, {}, "default"), null);
  assert.throws(() => readProject({ getItem: () => "{" }, "k"), SyntaxError);
  assert.throws(() => writeProject({ setItem() { throw new Error("quota"); } }, "k", {}), /quota/);
  const restored = restoreProjectPayload({ schema_version: "dag-builder-project-v1" }, {}, "default");
  assert.equal(restored.phase, "select_uoa");
  assert.equal(restored.variableLayoutSource, "default");
  assert.equal(restored.dagLayoutMode, "auto");
  assert.deepEqual(restored.project.groups, []);
});

test("undo then edit discards redo without changing the previous history", () => {
  const initial = { undoHistory: [], undoPointer: -1, actionLog: [] };
  const first = recordHistory(initial, "first", "0", "1", "t");
  const second = recordHistory(first, "second", "1", "2", "t");
  const step = historyStep(second, "undo");
  assert.equal(step.snapshot, "1");
  const undone = { ...second, undoPointer: step.undoPointer };
  assert.equal(historyStep(undone, "redo").snapshot, "2");
  const branch = recordHistory(undone, "branch", "1", "3", "t");
  assert.equal(historyStep(branch, "redo"), null);
  assert.deepEqual(branch.undoHistory.map(e => e.after), ["1", "3"]);
  assert.deepEqual(second.undoHistory.map(e => e.after), ["1", "2"]);
  assert.equal(recordHistory(branch, "noop", "3", "3", "t"), null);
  assert.deepEqual(initial.undoHistory, []);
});

test("history bounds retain the latest sixty edits and forty log entries", () => {
  let state = { undoHistory: [], undoPointer: -1, actionLog: [] };
  for (let i = 0; i < 70; i++) state = recordHistory(state, String(i), String(i), String(i + 1), "t");
  assert.equal(state.undoHistory.length, 60);
  assert.equal(state.actionLog.length, 40);
  assert.equal(state.undoPointer, 59);
  let count = 0;
  for (let step; (step = historyStep(state, "undo"));) {
    state = { ...state, undoPointer: step.undoPointer };
    count++;
  }
  assert.equal(count, 60);
  assert.equal(historyStep(state, "redo").snapshot, "11");
});
