// Focused real-data benchmark: run against a local server with PROFILE_URL.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { installEvidenceOption } from './profile_evidence_options.mjs';
const option = process.env.PROFILE_EVIDENCE_OPTION || 'baseline';
if (!['baseline', 'locality', 'full-shards', 'catalog', 'canonical'].includes(option)) throw new Error(`Unknown evidence option: ${option}`);
const output = process.env.PROFILE_OUTPUT || '/private/tmp/echo-load-evidence';
await mkdir(output, { recursive: true });
const port = process.env.PROFILE_PORT || "8779";
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
const report = { scenario: 'load-evidence', option, dataTransport: 'Playwright proxy (localhost CORS)', cpuThrottle: process.env.PROFILE_DEVICE === 'mobile' ? 4 : 1, url: process.env.PROFILE_URL || localUrl, runs: [] };
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
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
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
      const start = await page.evaluate(() => performance.now());
      await action();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      result.timings.push(await page.evaluate(({ start, name }) => ({ name, ms: performance.now() - start, longestTaskMs: Math.max(0, ...window.__anchorTasks.filter(t => t.at >= start).map(t => t.ms)), rows: document.querySelectorAll('#provenancePanel tbody tr').length }), { start, name }));
    }
    if (result.members < 90000) throw new Error(`Expected the new 100k schema; got ${result.members} members. Run node scripts/prepare_new_data_site.mjs first.`);
    result.snapshot = await page.evaluate(() => window.__dagBuilderState.data.snapshot);
    const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(g => g.variable_ids.length).slice(0, 2).map(g => g.group_id));
    await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
    await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
    await page.locator('#showUnfiltered').click();
    const edgeId = await page.evaluate(async () => {
      const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
      await api.whenDagRendered();
      const rendered = new Set(api.renderedDagEdgeIds());
      const edge = [...rendered].find(id => id !== '__study_design_iv_to_dv__');
      if (!edge) throw new Error('No evidence edge rendered');
      return edge;
    });
    result.edgeId = edgeId;
    result.rawLinksBefore = await page.evaluate(() => window.__dagBuilderState.rawLinksById.size);
    await installEvidenceOption(page, option);
    const requests = [];
    const requestStarts = new Map();
    context.on('request', request => requestStarts.set(request, performance.now()));
    context.on('requestfinished', async request => {
      const response = await request.response();
      requests.push({ url: request.url(), ms: performance.now() - requestStarts.get(request), status: response?.status(), method: request.method(), range: request.headers().range || null, bodyBytes: await response?.body().then(b => b.length).catch(() => 0) });
    });
    await cdp.send('Profiler.start');
    await measure('cold edge selection to visible findings', async () => {
      await page.evaluate(async id => {
        const api = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
        performance.mark('load-evidence-start');
        api.inspectDagEdge(id);
      }, edgeId);
      await page.getByRole('button', { name: /^Exclude finding / }).first().waitFor({ timeout: 180000 });
    });
    await measure('remaining evidence metadata', async () => {
      await page.waitForFunction(() => !window.__dagBuilderState.pendingEdgeEvidence, null, { timeout: 180000 });
    });
    result.evidence = await page.evaluate(() => {
      const s = window.__dagBuilderState;
      return { rawLinks: s.rawLinksById.size, variables: s.variableById.size,
        findings: document.querySelectorAll('button[aria-label^="Exclude finding "]').length,
        measures: performance.getEntriesByType('measure').filter(e => e.name.includes('evidence')).map(e => ({ name: e.name, ms: e.duration })) };
    });
    await page.locator('#closeEvidencePane').click();
    await measure('warm edge selection to visible findings', async () => {
      await page.evaluate(async id => (await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src)).inspectDagEdge(id), edgeId);
      await page.getByRole('button', { name: /^Exclude finding / }).first().waitFor();
      await page.waitForFunction(() => !window.__dagBuilderState.pendingEdgeEvidence);
    });
    if (process.env.PROFILE_VERIFY_PAGINATION === '1') {
      const section = page.locator('.provenance-direction').first();
      const before = await section.getByRole('button', { name: /^Exclude finding / }).first().getAttribute('aria-label');
      await measure('next page to visible findings', async () => {
        await section.getByRole('button', { name: 'Next', exact: true }).click();
        await page.waitForFunction(() => !window.__dagBuilderState.pendingEdgeEvidence, null, { timeout: 180000 });
        await section.getByRole('button', { name: /^Exclude finding / }).first().waitFor();
      });
      const after = await section.getByRole('button', { name: /^Exclude finding / }).first().getAttribute('aria-label');
      if (before === after) throw new Error('Next page did not change findings');
      await section.getByRole('button', { name: 'Previous', exact: true }).click();
      await page.waitForFunction(() => !window.__dagBuilderState.pendingEdgeEvidence);
      if (await section.getByRole('button', { name: /^Exclude finding / }).first().getAttribute('aria-label') !== before) throw new Error('Previous page did not restore findings');
      result.paginationVerified = true;
    }
    result.requests = [...requests];
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    const { profile } = await cdp.send('Profiler.stop');
    result.optionStats = await page.evaluate(() => window.__verifyEvidenceOption());
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    report.runs.push(result);
    delete report.currentRun;
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ run: run + 1, edgeId, timings: result.timings, requests: result.requests.length, optionStats: result.optionStats }));
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
    report.failureState = await page.evaluate(() => ({ updating: window.__dagBuilderState?.compiledDagUpdating,
      valid: window.__dagBuilderState?.compiledDagValid, selectedEdgeId: window.__dagBuilderState?.selectedEdgeId,
      findingDecisions: window.__dagBuilderState?.project?.finding_decisions,
      compiledEdge: window.__dagBuilderState?.compiledDag?.edges.find(e => e.edge_id === window.__dagBuilderState?.selectedEdgeId) })).catch(() => null);
    await context.unrouteAll({ behavior: 'ignoreErrors' });
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
  throw error;
} finally { await browser.close(); server?.kill(); }
