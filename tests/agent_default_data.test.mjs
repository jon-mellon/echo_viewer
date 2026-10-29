import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_DEFAULT_PUBLICATION_ID, AGENT_DEFAULT_SNAPSHOT_ID, agentDataSelection } from "../agent/default_data.mjs";

const OTHER = "f22dab8b-d9a7-4047-a775-0216b31c79fc";

test("with nothing chosen the agent uses the combined data the Echo UI defaults to", () => {
  assert.deepEqual(agentDataSelection(), { publicationId: AGENT_DEFAULT_PUBLICATION_ID, snapshotId: AGENT_DEFAULT_SNAPSHOT_ID });
  assert.equal(AGENT_DEFAULT_PUBLICATION_ID, "0d7bdf95-3f02-4e72-8629-e6d456434ad5");
  assert.equal(AGENT_DEFAULT_SNAPSHOT_ID, "8bf2706808428e59109baa285690135cdbe066e26d97a7d820c9935fc3881849");
});

test("the default snapshot goes only with the default publication", () => {
  assert.deepEqual(agentDataSelection({ publicationId: OTHER }), { publicationId: OTHER, snapshotId: "" });
  assert.deepEqual(agentDataSelection({ publicationId: OTHER, snapshotId: "a".repeat(64) }), { publicationId: OTHER, snapshotId: "a".repeat(64) });
  assert.deepEqual(agentDataSelection({ publicationId: AGENT_DEFAULT_PUBLICATION_ID }),
    { publicationId: AGENT_DEFAULT_PUBLICATION_ID, snapshotId: AGENT_DEFAULT_SNAPSHOT_ID });
  assert.equal(agentDataSelection({ snapshotId: "b".repeat(64) }).snapshotId, "b".repeat(64));
});
