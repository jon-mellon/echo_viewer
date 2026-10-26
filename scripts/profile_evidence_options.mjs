// Benchmark-only overrides: no production data or application modules are changed.
export async function installEvidenceOption(page, option) {
  await page.evaluate(async option => {
    const { dagDataSource: source } = await import('/dag_data_source.mjs?v=browser-v2');
    const { variableSearchCatalog: catalog } = await import('/variable_search_catalog.mjs');
    const originalLabels = source.loadVariableProvenance.bind(source);
    const originalLinks = source.loadRawLinksByIds.bind(source);
    const stats = window.__evidenceOption = { option, catalogStatusBefore: catalog.status, labelCalls: [], downloadedBytes: 0 };
    const collected = new Map();
    if (option === 'locality') {
      source.loadRawLinksByIds = async ids => {
        const rows = await originalLinks(ids);
        const byId = new Map(rows.map(row => [row.raw_causal_link_id, row]));
        const edge = window.__dagBuilderState.project.links.find(e => e.edge_id === window.__dagBuilderState.selectedEdgeId);
        const used = new Set();
        const shardIds = id => {
          const row = byId.get(id) || window.__dagBuilderState.rawLinksById.get(id);
          return row ? source.browserShardIds([row.source_variable_id, row.target_variable_id]) : [];
        };
        for (const field of ['a_to_b_raw_link_ids', 'b_to_a_raw_link_ids']) {
          const remaining = [...edge[field]];
          const first = [];
          while (first.length < 5 && remaining.length) {
            let best = 0, bestCost = Infinity;
            remaining.forEach((id, i) => {
              const cost = shardIds(id).filter(s => !used.has(s)).length;
              if (cost < bestCost) { best = i; bestCost = cost; }
            });
            const [id] = remaining.splice(best, 1);
            first.push(id);
            shardIds(id).forEach(s => used.add(s));
          }
          edge[field] = [...first, ...remaining];
        }
        stats.firstPageShards = used.size;
        return rows;
      };
    }
    const files = new Map();
    source.loadVariableProvenance = async ids => {
      const start = performance.now();
      let rows;
      if (option === 'catalog') {
        await catalog.loadSnapshot(window.__dagBuilderState.data.snapshot.snapshot_id, {
          loadRecords: () => source.loadVariableSearchRecords(),
        });
        const missing = ids.filter(id => !catalog.recordById.has(id));
        rows = ids.filter(id => catalog.recordById.has(id)).map(id => {
          const record = catalog.recordById.get(id);
          return { variable_id: id, display_label: record[1], concept_label: record[2] };
        });
        if (missing.length) rows.push(...await originalLabels(missing));
      } else if (option === 'canonical') {
        await source.ensureEvidenceConnection();
        const url = source.canonicalEvidenceRelationUrl('variable_occurrences');
        if (!url) throw new Error('Snapshot does not declare canonical variable occurrences');
        const statement = await source.connection.prepare(`SELECT variable_id, concept_label, display_label FROM read_parquet('${url.replaceAll("'", "''")}') WHERE variable_id IN (${ids.map(() => '?').join(',')})`);
        try { rows = (await statement.query(...ids)).toArray().map(row => row.toJSON()); }
        finally { await statement.close(); }
      } else if (option === 'full-shards') {
        await source.ensureEvidenceConnection();
        const urls = source.browserUrls(source.browserLayout.variables, ids);
        // Fetch up to six whole existing files concurrently, register in memory,
        // and query locally, eliminating remote metadata/range round trips.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(6, urls.length) }, async () => {
          while (next < urls.length) {
            const url = urls[next++];
            if (!files.has(url)) files.set(url, (async () => {
              const response = await fetch(url);
              if (!response.ok) throw new Error(`Shard fetch failed: ${response.status}`);
              const bytes = new Uint8Array(await response.arrayBuffer());
              stats.downloadedBytes += bytes.byteLength;
              const name = `profile-label-${url.split('/').pop()}`;
              await source.connection.bindings.registerFileBuffer(name, bytes);
              return name;
            })());
            await files.get(url);
          }
        }));
        const names = await Promise.all(urls.map(url => files.get(url)));
        const statement = await source.connection.prepare(`SELECT variable_id, concept_label, display_label FROM read_parquet([${names.map(n => `'${n}'`).join(',')}]) WHERE variable_id IN (${ids.map(() => '?').join(',')})`);
        try { rows = (await statement.query(...ids)).toArray().map(row => row.toJSON()); }
        finally { await statement.close(); }
      } else rows = await originalLabels(ids);
      rows.forEach(row => collected.set(row.variable_id, row));
      stats.labelCalls.push({ ids: ids.length, ms: performance.now() - start });
      return rows;
    };
    window.__verifyEvidenceOption = async () => {
      // Untimed correctness check against the existing Parquet retrieval path.
      const expected = await originalLabels([...collected.keys()]);
      if (expected.length !== collected.size) throw new Error('Label coverage mismatch');
      for (const row of expected) {
        const actual = collected.get(row.variable_id);
        if (row.concept_label !== actual.concept_label || row.display_label !== actual.display_label) throw new Error(`Label mismatch for ${row.variable_id}`);
      }
      return { ...stats, labelsVerified: expected.length };
    };
  }, option);
}
