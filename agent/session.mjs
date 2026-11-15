import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { EchoSessionCore } from "../site/echo_session_core.mjs";
import { openRouterJson } from "../site/definition_jev_core.mjs";
import { checkAdjustmentEnabled, checkOnlyViaEnabled } from "./diagnostic_checks.mjs";
import { agentDataSelection } from "./default_data.mjs";
import { agentHome, clonePublication, openLocalPublication, localEvidence } from "./local_data.mjs";
export { CATCH_ALL_GROUP_IDS } from "../site/echo_session_core.mjs";

export class EchoAgentSession extends EchoSessionCore {
  constructor(record, home = agentHome()) {
    super(record, { evidence: localEvidence(join(home, "snapshots", record.snapshotId)),
      getKey: () => process.env.OPENROUTER_API_KEY, request: openRouterJson,
      get checkOnlyVia() { return checkOnlyViaEnabled(); }, get checkAdjustment() { return checkAdjustmentEnabled(); },
      ownerStorage: { getItem: key => key === "echo-owner-token" ? process.env.ECHO_OWNER_TOKEN || null : null } });
    this.home = home;
  }
  static async start(options = {}) {
    const { home = agentHome(), sync = true, onProgress } = options;
    const { publicationId, snapshotId } = agentDataSelection(options);
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

  async save() {
    const path = join(this.home, "sessions", `${this.record.id}.json`);
    await mkdir(join(this.home, "sessions"), { recursive: true });
    const temporary = `${path}.part-${process.pid}`;
    await writeFile(temporary, JSON.stringify(this.record, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  }
}
