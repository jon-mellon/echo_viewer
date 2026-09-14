#!/usr/bin/env node
// Admin/backfill entry point. It deliberately needs exported schema and evidence
// JSON files so credentials and R2 writes never enter the browser application.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCompiledArtifacts, evidenceSnapshotForSchema, fullCompileDag } from "../site/compiled_dag.mjs";

const [schemaFile, evidenceFile, publicationId, outputDirectory] = process.argv.slice(2);
if (!schemaFile || !evidenceFile || !publicationId || !outputDirectory) {
  console.error("usage: node scripts/backfill_compiled_publication.mjs SCHEMA.json EVIDENCE.json PUBLICATION_ID OUTPUT_DIR");
  process.exitCode = 2;
} else {
  const schema = JSON.parse(await readFile(schemaFile, "utf8"));
  const rawLinks = JSON.parse(await readFile(evidenceFile, "utf8"));
  const schemaHash = process.env.ECHO_SCHEMA_HASH;
  if (!schemaHash) throw new Error("Set ECHO_SCHEMA_HASH to the publication registry content_hash.");
  const dag = fullCompileDag({ schema, rawLinks });
  const artifacts = await createCompiledArtifacts({ publicationId, schemaHash,
    evidenceSnapshot: evidenceSnapshotForSchema(schema), dag });
  const dagPath = resolve(outputDirectory, "compiled/dag.json");
  const manifestPath = resolve(outputDirectory, "compiled/manifest.json");
  await mkdir(dirname(dagPath), { recursive: true });
  await writeFile(dagPath, artifacts.dagBytes);
  await writeFile(manifestPath, artifacts.manifestBytes);
  console.log(JSON.stringify({ dagPath, manifestPath, ...artifacts.manifest.row_counts }));
}
