/**
 * The data the agent uses when nothing is chosen: the combined 100k + socsci publication and snapshot that the
 * Echo UI defaults to (see DEFAULT_DATA_PUBLICATION and DEFAULT_DATA_SNAPSHOT in deploy-staging.yml).
 * Override with ECHO_AGENT_PUBLICATION and ECHO_AGENT_SNAPSHOT.
 */
export const AGENT_DEFAULT_PUBLICATION_ID = process.env.ECHO_AGENT_PUBLICATION || "0d7bdf95-3f02-4e72-8629-e6d456434ad5";
export const AGENT_DEFAULT_SNAPSHOT_ID = process.env.ECHO_AGENT_SNAPSHOT
  || "8bf2706808428e59109baa285690135cdbe066e26d97a7d820c9935fc3881849";

/**
 * Resolve the publication and snapshot to use. With nothing chosen, both default to the combined data. A caller
 * that names a different publication keeps the old resolution for its snapshot (an explicit snapshot, or the one
 * Echo's production manifest names), because the default snapshot belongs to the default publication.
 */
export function agentDataSelection({ publicationId, snapshotId } = {}) {
  const resolvedPublication = publicationId || AGENT_DEFAULT_PUBLICATION_ID;
  const usesDefault = resolvedPublication === AGENT_DEFAULT_PUBLICATION_ID;
  return { publicationId: resolvedPublication, snapshotId: snapshotId || (usesDefault ? AGENT_DEFAULT_SNAPSHOT_ID : "") };
}
