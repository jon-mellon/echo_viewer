import test from "node:test";
import assert from "node:assert/strict";
import { eligiblePreviousSplits, previousSplitsForRole } from "../site/previous_split_candidates.mjs";
import { splitCategories } from "../site/dag_project.mjs";

const parents = [{ group_id: "a", label: "Parent A", variable_ids: ["1", "2"] },
  { group_id: "b", label: "Parent B", variable_ids: ["3", "4"] }];
const row = { group_id: "saved", split_id: "split", name: "Saved variable", description: "A sufficiently long definition.",
  source_group_ids: ["a", "b"], source_group_by_variable: { 1: "a", 2: "a", 3: "b", 4: "b" },
  local_variable_ids: ["1", "3"], published_at: "2026-01-01" };

test("offers only splits with verified unchanged parents and valid saved memberships", () => {
  assert.deepEqual(eligiblePreviousSplits([row], parents)[0].source_labels, ["Parent A", "Parent B"]);
  for (const bad of [
    { ...row, source_group_by_variable: undefined },
    { ...row, local_variable_ids: ["1", "missing"] },
    { ...row, local_variable_ids: ["1", "2"] },
  ]) assert.deepEqual(eligiblePreviousSplits([bad], parents), []);
  assert.deepEqual(eligiblePreviousSplits([row], [parents[0], { ...parents[1], variable_ids: ["3", "5"] }]), []);
  assert.deepEqual(eligiblePreviousSplits([row], [parents[0]]), []);
});

test("filters before choosing the newest name and recognizes reused origins", () => {
  const newerBad = { ...row, group_id: "new", name: " SAVED VARIABLE ", published_at: "2027", local_variable_ids: ["missing"] };
  const newerGood = { ...row, group_id: "newer", name: "saved variable", published_at: "2026-02-01" };
  assert.deepEqual(eligiblePreviousSplits([newerBad, row], parents).map(item => item.group_id), ["saved"]);
  assert.deepEqual(eligiblePreviousSplits([row, newerGood], parents).map(item => item.group_id), ["newer"]);
  assert.deepEqual(eligiblePreviousSplits([row], [...parents, { group_id: "copy", label: "Renamed",
    provenance: { reused_from_split_id: "split" } }]), []);
});

test("role alternatives are checked with the currently selected split undone, without changing the project", () => {
  const base = { groups: parents, decisions: [] };
  const project = splitCategories(base, { sourceGroupIds: ["a", "b"], newGroupId: "current", newLabel: "Current split",
    newDescription: "The current split description.", newVariableIds: ["1", "3"], residualLabels: { a: "Parent A", b: "Parent B" },
    role: "dv", timestamp: "2026" });
  const before = structuredClone(project);
  assert.deepEqual(eligiblePreviousSplits([row], project.groups), []);
  const alternatives = previousSplitsForRole([row], project, "dv");
  assert.equal(alternatives[0].replaces_group_id, "current");
  assert.deepEqual(previousSplitsForRole([row], project, "iv"), []);
  assert.deepEqual(previousSplitsForRole([row], project, "candidate", "current"), []);
  const focusProject = { ...project, dv_group_id: null };
  assert.equal(previousSplitsForRole([row], focusProject, "candidate", "current")[0].replaces_group_id, "current");
  assert.deepEqual(project, before);
  const changed = { ...project, groups: project.groups.map(group => group.group_id === "a"
    ? { ...group, variable_ids: ["unknown"] } : group) };
  assert.deepEqual(previousSplitsForRole([row], changed, "dv"), []);
});
