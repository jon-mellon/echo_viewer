#!/usr/bin/env node
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import { GROUPING_FORMAT_VERSION } from "../site/app_contracts.mjs";
import { canonicalFolderHash, writeGroupingSchemaFolder } from "../site/grouping_schema_writer.mjs";
import { createCompiledArtifacts, fullCompileDag } from "../site/compiled_dag.mjs";

function parseMapping(text, source) {
  const result = {};
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid mapping line ${index + 1} in ${source}.`);
    const key = line.slice(0, separator);
    const raw = line.slice(separator + 1).trim();
    try { result[key] = JSON.parse(raw); } catch { result[key] = raw; }
  }
  return result;
}

function parseTsv(text, source) {
  const records = [];
  let record = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "\t" && !quoted) { record.push(value); value = ""; }
    else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      record.push(value);
      if (record.some(cell => cell !== "")) records.push(record);
      record = []; value = "";
    } else value += character;
  }
  if (quoted) throw new Error(`Unterminated quoted TSV field in ${source}.`);
  if (value || record.length) { record.push(value); records.push(record); }
  if (!records.length) throw new Error(`Empty TSV file: ${source}.`);
  const columns = records[0];
  return records.slice(1).map(values => Object.fromEntries(columns.map((column, index) => [column, values[index]])));
}

async function loadV2(directory) {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  if (manifest.format_version !== "groupings-v2") throw new Error(`${directory} is not a groupings-v2 bundle.`);
  const schema = parseMapping(await readFile(resolve(directory, manifest.schema_file), "utf8"), manifest.schema_file);
  Object.assign(schema, manifest.extra || {});
  schema.schema_version = GROUPING_FORMAT_VERSION;
  schema.membership_unit = manifest.membership_unit || "canonical_variable";
  schema.cache_compatibility = manifest.compatibility || {};
  if (manifest.built_against) schema.built_against = manifest.built_against;
  if (manifest.provenance && Object.keys(manifest.provenance).length) schema.migration_provenance = manifest.provenance;
  const groups = new Map();
  for (const relative of manifest.group_files || []) {
    const group = parseMapping(await readFile(resolve(directory, relative), "utf8"), relative);
    group.variable_ids = [];
    groups.set(group.group_id, group);
  }
  const owners = new Map();
  for (const relative of manifest.membership_shards || []) {
    for (const row of parseTsv(await readFile(resolve(directory, relative), "utf8"), relative)) {
      if (!groups.has(row.group_id)) throw new Error(`Unknown group ${row.group_id}.`);
      if (owners.has(row.variable_id)) throw new Error(`Duplicate membership ${row.variable_id}.`);
      owners.set(row.variable_id, row.group_id);
      groups.get(row.group_id).variable_ids.push(row.variable_id);
    }
  }
  schema.groups = [...groups.values()].sort((a, b) => a.group_id.localeCompare(b.group_id));
  for (const group of schema.groups) group.variable_ids.sort();
  schema.rejected_variables = manifest.rejected_file
    ? parseTsv(await readFile(resolve(directory, manifest.rejected_file), "utf8"), manifest.rejected_file).map(row => ({
        ...row,
        member_variable_ids: JSON.parse(row.member_variable_ids || "[]"),
        previous_group_ids: JSON.parse(row.previous_group_ids || "[]"),
      }))
    : [];
  return schema;
}

async function writeFiles(directory, files) {
  await rm(directory, { recursive: true, force: true });
  for (const [relative, bytes] of files) {
    const path = resolve(directory, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
}

const [inputDirectory, outputDirectory, publicationId, rawLinksFile] = process.argv.slice(2);
if (!inputDirectory || !outputDirectory || !publicationId) {
  console.error("usage: node scripts/convert_grouping_schema_v3.mjs INPUT_DIR OUTPUT_DIR PUBLICATION_ID [RAW_LINKS.json]");
  process.exitCode = 2;
} else {
  const schema = await loadV2(resolve(inputDirectory));
  const files = await writeGroupingSchemaFolder(schema, webcrypto);
  const contentHash = await canonicalFolderHash(files, webcrypto);
  const oldDagPath = resolve(inputDirectory, "compiled/dag.json");
  let compiledManifestHash = null;
  try {
    let dag;
    try { dag = JSON.parse(await readFile(oldDagPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT" || !rawLinksFile) throw error;
      dag = fullCompileDag({ schema, rawLinks: JSON.parse(await readFile(resolve(rawLinksFile), "utf8")) });
    }
    const evidenceSnapshot = schema.built_against?.record_signature || schema.cache_compatibility?.record_signature;
    const compiled = await createCompiledArtifacts({ publicationId, schemaHash: contentHash, evidenceSnapshot, dag, cryptoApi: webcrypto });
    files.set("compiled/dag.json", compiled.dagBytes);
    files.set("compiled/manifest.json", compiled.manifestBytes);
    compiledManifestHash = await (async () => {
      const digest = await webcrypto.subtle.digest("SHA-256", compiled.manifestBytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    })();
  } catch (error) {
    if (error?.code !== "ENOENT" || rawLinksFile) throw error;
  }
  await writeFiles(resolve(outputDirectory), files);
  console.log(JSON.stringify({ publication_id: publicationId, content_hash: contentHash,
    compiled_manifest_hash: compiledManifestHash, groups: schema.groups.length,
    memberships: schema.groups.reduce((sum, group) => sum + group.variable_ids.length, 0), files: files.size }));
}
