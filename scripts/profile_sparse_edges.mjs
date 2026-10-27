// Run node scripts/prepare_new_data_site.mjs first, then:
// PROFILE_OUTPUT=performance/sparse-edges-YYYY-MM-DD node scripts/profile_sparse_edges.mjs
// PROFILE_RUNS defaults to 3; PROFILE_DEVICE=mobile applies 4x CPU throttling.
// Each run uses a fresh browser context. Real data is proxied for localhost CORS;
// timings include that overhead. CPU traces and summary.json survive failures.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.PROFILE_OUTPUT || '/private/tmp/echo-sparse-edges';
await mkdir(output, { recursive: true });
const port = process.env.PROFILE_PORT || "8776";
const localUrl = `http://127.0.0.1:${port}/`;
const server = process.env.PROFILE_URL ? null : spawn('python3', ['-u', '-m', 'http.server', port, '--directory', process.env.PROFILE_SITE_DIR || 'dist/new-data-site'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (server) await new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => { server.kill(); reject(new Error('Preview server did not start')); }, 5000);
  const receive = chunk => {
    output += chunk;
    if (output.includes('Serving HTTP')) { clearTimeout(timer); resolve(); }
  };
  server.stdout.on('data', receive);
  server.stderr.on('data', receive);
  server.once('error', error => { clearTimeout(timer); reject(error); });
  server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview server exited (${code}): ${output}`)); });
});
let activeCdp;
const browser = await chromium.launch({ headless: true });
const report = { scenario: 'sparse-edges', dataTransport: 'Playwright proxy (localhost CORS)', cpuThrottle: process.env.PROFILE_DEVICE === 'mobile' ? 4 : 1, url: process.env.PROFILE_URL || localUrl, runs: [] };
try {
  for (let run = 0; run < Number(process.env.PROFILE_RUNS || 3); run++) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    // Proxy immutable data requests through Playwright to avoid localhost CORS.
    // Transfers still use the real remote data; timings include proxy overhead.
    await context.route('https://data.epistemicinfra.org/**', async route => {
      const headers = { ...route.request().headers() };
      delete headers.origin;
      delete headers.referer;
      let response = await route.fetch({ headers });
      for (let retry = 0; response.status() >= 500 && retry < 2; retry++) response = await route.fetch({ headers });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    const errors = [];
    let expectedEvidenceFailure = false;
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => {
      if (message.type() !== 'error') return;
      console.error(message.text());
      if (!expectedEvidenceFailure && message.text().includes('Could not load sparse edge evidence')) {
        errors.push(message.text());
        void page.evaluate(error => { window.__sparseProfileFailure = error; }, message.text()).catch(() => {});
      }
    });
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
      performance.setResourceTimingBufferSize(10000);
      window.__anchorTasks = [];
      new PerformanceObserver(list => window.__anchorTasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    activeCdp = cdp;
    page.setDefaultTimeout(30000);
    if (process.env.PROFILE_DEVICE === 'mobile') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(report.url);
    await page.waitForFunction(() => window.__dagBuilderState?.project && window.__dagBuilderState?.compiledDag && document.getElementById('startupLoading')?.hidden && window.__dagBuilderState?.publishedSchemaHydrated && !window.__dagBuilderState.publishedSchemaHydrating, null, { timeout: 180000 });
    console.log(`Run ${run + 1}: schema ready`);
    const result = await page.evaluate(() => {
      const s = window.__dagBuilderState;
      return { groups: s.project.groups.length, members: s.project.groups.reduce((n, g) => n + g.variable_ids.length, 0), hydratedVariables: s.variableById.size };
    });
    report.currentRun = result;
    result.errors = errors;
    result.timings = [];
    await cdp.send('Profiler.enable');
    async function measure(name, action) {
      result.pendingScenario = name;
      const start = await page.evaluate(() => performance.now());
      let failure;
      try {
        await action();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      } catch (error) {
        failure = error;
      }
      const timing = await page.evaluate(({ start, name }) => {
        const resources = performance.getEntriesByType('resource').filter(r => r.startTime >= start);
        const tasks = window.__anchorTasks.filter(t => t.at >= start);
        return { name, ms: performance.now() - start,
          longestTaskMs: Math.max(0, ...tasks.map(t => t.ms)),
          totalLongTaskMs: tasks.reduce((sum, t) => sum + t.ms, 0),
          requestCount: resources.length,
          // Resource sizes may be zero across origins without Timing-Allow-Origin.
          decodedBodyBytes: resources.reduce((sum, r) => sum + r.decodedBodySize, 0),
          visibleEdges: window.__dagBuilderState.visibleLinks.length,
          loadedEvidence: window.__dagBuilderState.rawLinksById.size,
          supportRecords: window.__dagBuilderState.edgeSupportById?.size || 0 };
      }, { start, name });
      result.timings.push({ ...timing, status: failure ? 'failed' : 'passed' });
      if (failure) throw failure;
      delete result.pendingScenario;
    }
    if (result.members < 90000) throw new Error(`Expected the new 100k schema; got ${result.members} members. Run node scripts/prepare_new_data_site.mjs first.`);
    result.snapshot = await page.evaluate(() => window.__dagBuilderState.data.snapshot);
    const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(g => g.variable_ids.length).slice(0, 2).map(g => g.group_id));
    await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
    await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
    await page.locator('.filter-dropdown > summary').click();
    await page.locator('#showUnfiltered').click();
    const apiUrl = await page.locator('script[type="module"][src*="dag_builder.js"]').getAttribute('src');
    async function settled() {
      await page.waitForFunction(() => {
        if (window.__sparseProfileFailure) throw new Error(window.__sparseProfileFailure);
        const s = window.__dagBuilderState;
        return !s.compiledDagUpdating && (!s.excludeSparseEdges || s.project.links.every(link =>
          [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])].every(id => s.edgeSupportById?.has(id) || s.rawLinksById.has(id))));
      }, null, { timeout: 180000 });
      await page.evaluate(async src => (await import(src)).whenDagRendered(), apiUrl);
    }
    async function verify(minimum) {
      if (process.env.PROFILE_VERIFY_RAW === '1') await page.evaluate(async () => {
        if (window.__profileRawSupport) return;
        const s = window.__dagBuilderState;
        const ids = [...new Set(s.project.links.flatMap(link =>
          [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])]))];
        const { dagDataSource } = await import('/dag_data_source.mjs?v=browser-v2');
        window.__profileRawSupport = new Map((await dagDataSource.loadRawLinksByIds(ids))
          .map(row => [row.raw_causal_link_id, row]));
      });
      return page.evaluate(async ({ minimum, apiUrl }) => {
        const s = window.__dagBuilderState;
        const expected = s.project.links.filter(link => {
          if (link.display_status === 'excluded' && !link.is_target_relation) return false;
          if (!s.excludeSparseEdges) return true;
          const papers = new Set([...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])].flatMap(id => {
            const raw = (window.__profileRawSupport || s.edgeSupportById || s.rawLinksById).get(id) || s.rawLinksById.get(id);
            const claim = String(raw?.causal_link_existence || '').trim().toLowerCase();
            return raw?.paper_id && (!claim || claim === 'present') ? [raw.paper_id] : [];
          }));
          return papers.size >= minimum;
        }).map(link => link.edge_id).sort();
        const actual = s.visibleLinks.map(link => link.edge_id).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Sparse filter evidence mismatch');
        const rendered = new Set((await import(apiUrl)).renderedDagEdgeIds());
        if (actual.some(id => !rendered.has(id))) throw new Error('Filtered edges missing from rendered map');
        const evidenceIds = new Set(s.project.links.map(link => link.edge_id));
        if ([...rendered].some(id => evidenceIds.has(id) && !actual.includes(id))) {
          throw new Error('Excluded sparse edges remain rendered');
        }
        return { minimum, enabled: s.excludeSparseEdges, edges: actual.length };
      }, { minimum, apiUrl });
    }
    await settled();
    result.baselineEdges = await page.evaluate(() => window.__dagBuilderState.visibleLinks.length);
    if (await page.locator('#toggleSparseEdges').getAttribute('aria-pressed') !== 'false') throw new Error('Filter must start disabled');
    result.checks = [];
    await cdp.send('Profiler.start');
    await measure('enable sparse filter (cold evidence, minimum 2)', async () => {
      await page.locator('#toggleSparseEdges').click();
      await settled();
    });
    result.checks.push(await verify(2));
    for (const minimum of [3, 5, 2]) {
      await measure(`change minimum papers to ${minimum} (warm evidence)`, async () => {
        await page.locator('#minimumEdgePapers').fill(String(minimum));
        await settled();
      });
      result.checks.push(await verify(minimum));
    }
    await measure('disable sparse filter', async () => {
      await page.locator('#toggleSparseEdges').click();
      await settled();
    });
    result.checks.push(await verify(2));
    await measure('enable sparse filter (warm evidence, minimum 2)', async () => {
      await page.locator('#toggleSparseEdges').click();
      await settled();
    });
    result.checks.push(await verify(2));
    if (process.env.PROFILE_TEST_FAILURE === '1') {
      // Exercise pending and failed loads through the real UI, independently
      // of the performance measurements. Restore the adapter/cache afterwards.
      await page.locator('#toggleSparseEdges').click();
      await settled();
      expectedEvidenceFailure = true;
      for (const mode of ['reject', 'missing']) {
        await page.evaluate(async () => {
          const { dagDataSource } = await import('/dag_data_source.mjs?v=browser-v2');
          const s = window.__dagBuilderState;
          const id = s.project.links.flatMap(link => link.a_to_b_raw_link_ids || [])[0];
          const row = s.edgeSupportById.get(id);
          s.edgeSupportById.delete(id);
          const original = dagDataSource.loadRawLinkSupportByIds;
          dagDataSource.loadRawLinkSupportByIds = () => new Promise((resolve, reject) => {
            window.__finishSparseTest = mode => mode === 'reject'
              ? reject(new Error('Injected sparse evidence failure')) : resolve([]);
          });
          window.__restoreSparseTest = () => {
            dagDataSource.loadRawLinkSupportByIds = original;
            s.edgeSupportById.set(id, row);
          };
        });
        await page.locator('#toggleSparseEdges').click();
        await page.waitForFunction(() => Boolean(window.__finishSparseTest));
        const pendingEdges = await page.evaluate(() => window.__dagBuilderState.visibleLinks.length);
        if (pendingEdges !== result.baselineEdges) throw new Error('Pending evidence changed the visible map');
        await page.evaluate(mode => window.__finishSparseTest(mode), mode);
        await page.waitForFunction(() => !window.__dagBuilderState.excludeSparseEdges
          && document.getElementById('toggleSparseEdges').getAttribute('aria-pressed') === 'false');
        await settled();
        const recoveredEdges = await page.evaluate(() => window.__dagBuilderState.visibleLinks.length);
        if (recoveredEdges !== result.baselineEdges) throw new Error('Evidence failure left an incomplete map');
        await page.evaluate(() => {
          window.__restoreSparseTest();
          delete window.__finishSparseTest;
          delete window.__restoreSparseTest;
        });
        (result.failureRecoveryChecks ||= []).push({ mode, pendingEdges, recoveredEdges });
      }
      expectedEvidenceFailure = false;
    }
    if (process.env.PROFILE_VERIFY_RAW === '1') {
      const evidenceIds = await page.evaluate(async apiUrl => {
        const s = window.__dagBuilderState;
        const edge = [...s.visibleLinks].filter(link => !link.is_target_relation)
          .sort((a, b) => (a.a_to_b_raw_link_ids.length + a.b_to_a_raw_link_ids.length)
            - (b.a_to_b_raw_link_ids.length + b.b_to_a_raw_link_ids.length))[0];
        (await import(apiUrl)).inspectDagEdge(edge.edge_id);
        return [...edge.a_to_b_raw_link_ids, ...edge.b_to_a_raw_link_ids];
      }, apiUrl);
      await page.waitForFunction(ids => !window.__dagBuilderState.pendingEdgeEvidence && ids.every(id =>
        window.__dagBuilderState.rawLinksById.get(id)?.source_variable_id), evidenceIds);
      result.fullEvidenceVerified = true;
      result.inspectorDetailRecords = evidenceIds.length;
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    report.runs.push(result);
    delete report.currentRun;
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result));
    await context.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
} catch (error) {
  report.error = String(error);
  console.error(report.error);
  // Preserve the failing transition's CPU trace as well as successful runs.
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: `${output}/failure.png`, timeout: 5000, animations: 'disabled' }).catch(() => {});
    const stopped = await activeCdp?.send('Profiler.stop').catch(() => null);
    if (stopped) await writeFile(`${output}/failure.cpuprofile`, JSON.stringify(stopped.profile));
    report.failureState = await page.evaluate(() => ({ sparse: window.__dagBuilderState?.excludeSparseEdges, minimum: window.__dagBuilderState?.minimumEdgePapers, updating: window.__dagBuilderState?.compiledDagUpdating,
      valid: window.__dagBuilderState?.compiledDagValid, visibleEdges: window.__dagBuilderState?.visibleLinks?.length,
      totalEdges: window.__dagBuilderState?.project?.links?.length,
      loadedEvidence: window.__dagBuilderState?.rawLinksById?.size,
      requiredEvidence: new Set((window.__dagBuilderState?.project?.links || []).flatMap(link =>
        [...(link.a_to_b_raw_link_ids || []), ...(link.b_to_a_raw_link_ids || [])])).size })).catch(() => null);
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
  throw error;
} finally { await browser.close(); server?.kill(); }
