// Focused, real-data cold definition and path expansion benchmark.
// Prepare dist/new-data-site first. Run sequentially with other local profilers.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

const output = process.env.PROFILE_OUTPUT || '/private/tmp/echo-definition-paths';
const mobile = process.env.PROFILE_DEVICE === 'mobile';
const port = process.env.PROFILE_PORT || '8782';
const url = `http://127.0.0.1:${port}/`;
await mkdir(output, { recursive: true });
const server = spawn('python3', ['-u', '-m', 'http.server', port, '--directory',
  process.env.PROFILE_SITE_DIR || 'dist/new-data-site'], { stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const report = { mobile, runs: [] };
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview failed to start')), 5000);
    const receive = chunk => { if (String(chunk).includes('Serving HTTP')) { clearTimeout(timer); resolve(); } };
    server.stdout.on('data', receive);
    server.stderr.on('data', receive);
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited: ${code}`)); });
    server.once('error', reject);
  });
  browser = await chromium.launch({ headless: true });
  for (let run = 0; run < Number(process.env.PROFILE_RUNS || 1); run++) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 },
      isMobile: mobile, hasTouch: mobile });
    // Immutable remote data still travels over the network; proxy avoids localhost CORS.
    await context.route('https://data.epistemicinfra.org/**', async route => {
      const headers = { ...route.request().headers() };
      delete headers.origin;
      delete headers.referer;
      const response = await route.fetch({ headers });
      await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
      window.__focusedTasks = [];
      new PerformanceObserver(list => window.__focusedTasks.push(...list.getEntries()
        .map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url, options) { super(url, options); this.layoutWorker = String(url).includes('dag_layout_worker'); }
        postMessage(message, ...rest) {
          if (this.layoutWorker && message.input) window.__lastLayoutInput = message.input;
          return super.postMessage(message, ...rest);
        }
      };
    });
    const cdp = await context.newCDPSession(page);
    if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
      && document.getElementById('startupLoading')?.hidden, null, { timeout: 180000 });
    const result = await page.evaluate(() => ({ snapshot: window.__dagBuilderState.data.snapshot.snapshot_id,
      members: window.__dagBuilderState.project.groups.reduce((n, group) => n + group.variable_ids.length, 0) }));
    result.timings = [];
    async function measure(name, action) {
      const start = await page.evaluate(() => performance.now());
      await action();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      result.timings.push(await page.evaluate(({ name, start }) => ({ name, ms: performance.now() - start,
        longestTaskMs: Math.max(0, ...window.__focusedTasks.filter(t => t.at >= start).map(t => t.ms)),
        measures: performance.getEntriesByType('measure').filter(e => e.startTime >= start).map(e => ({ name: e.name, ms: e.duration })),
        nodes: window.__dagBuilderState.componentGroupIds.size, edges: window.__dagBuilderState.visibleLinks.length }), { name, start }));
    }
    await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
    await page.locator('#definitionChooseManual').click();
    await measure('cold definition source', async () => {
      await page.locator('#definitionSourceList input[data-source-id]').first().check();
      await page.locator('#definitionContinue').click();
      if (mobile) await page.locator('button[data-mobile-panel="variables"]').click();
      await page.locator('#dagZoomIn').waitFor({ state: 'visible' });
    });
    if (mobile) await page.locator('button[data-mobile-panel="controls"]').click();
    await page.locator('#definitionCancel').click();
    const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups.filter(g => g.variable_ids.length).slice(0, 2).map(g => g.group_id));
    await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
    await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
    if (mobile) await page.locator('button[data-mobile-panel="dag"]').click();
    async function rendered() {
      await page.evaluate(async () => (await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src)).whenDagRendered());
    }
    await rendered();
    await page.locator('.filter-dropdown > summary').click();
    await page.locator('#showUnfiltered').click();
    await rendered();
    for (const id of ['toggleConfoundersOnly', 'toggleCollidersOnly', 'toggleBottleneckedConfounders', 'toggleIrrelevantConfounderLinks']) {
      await page.locator(`#${id}`).click();
      await rendered();
    }
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    for (const length of [2, 1, 2]) {
      await measure(`path length ${length}`, async () => {
        await page.locator('#confounderPathLength').fill(String(length));
        await page.waitForFunction(n => window.__dagBuilderState.confounderMaxPathLength === n, length);
        await rendered();
      });
      await page.evaluate(async () => {
        const state = window.__dagBuilderState;
        const { renderedDagEdgeIds } = await import(document.querySelector('script[type="module"][src*="dag_builder.js"]').src);
        const groups = new Set(state.project.groups.filter(g => state.componentGroupIds.has(g.group_id)
          && g.type !== 'other' && g.group_id !== 'other' && String(g.label || '').trim().toLowerCase() !== 'other').map(g => g.group_id));
        const expected = state.visibleLinks.filter(link => !link.is_target_relation && groups.has(link.group_a) && groups.has(link.group_b))
          .map(link => link.edge_id).sort();
        const actual = renderedDagEdgeIds().filter(id => !id.startsWith('__study_')).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Rendered filtered edges differ from current graph');
      });
    }
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    await writeFile(`${output}/input-${run}.json`, JSON.stringify(await page.evaluate(() => window.__lastLayoutInput)));
    result.errors = errors;
    report.runs.push(result);
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result));
    await context.close();
    if (errors.length) throw new Error(errors.join('\n'));
  }
} finally {
  await browser?.close();
  server.kill();
}
