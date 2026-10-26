// Focused real-data benchmark: run against a local server with PROFILE_URL.
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { routeProfileSite } from "./profile_site_route.mjs";
import { mkdir, writeFile } from 'node:fs/promises';
const output = process.env.PROFILE_OUTPUT || '/private/tmp/echo-anchor-search';
await mkdir(output, { recursive: true });
const port = process.env.PROFILE_PORT || "8767";
const localUrl = `http://127.0.0.1:${port}/`;
const server = process.env.PROFILE_URL ? null : spawn('python3', ['-u', '-m', 'http.server', port, '--directory', process.env.PROFILE_SITE_DIR || 'site'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
const browser = await chromium.launch({ headless: true });
const report = { cpuThrottle: process.env.PROFILE_DEVICE === 'mobile' ? 4 : 1, url: process.env.PROFILE_URL || localUrl, routedSite: process.env.PROFILE_ROUTE_SITE_DIR || null, runs: [] };
try {
  for (let run = 0; run < Number(process.env.PROFILE_RUNS || 3); run++) {
    const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
    await routeProfileSite(context, report.url, process.env.PROFILE_ROUTE_SITE_DIR);
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
    if (process.env.PROFILE_DEVICE === 'mobile') await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(report.url);
    await page.waitForFunction(() => window.__dagBuilderState?.project && window.__dagBuilderState?.compiledDag && document.getElementById('startupLoading')?.hidden && window.__dagBuilderState?.publishedSchemaHydrated && !window.__dagBuilderState.publishedSchemaHydrating, null, { timeout: 180000 });
    const result = await page.evaluate(() => {
      const s = window.__dagBuilderState;
      return { groups: s.project.groups.length, members: s.project.groups.reduce((n, g) => n + g.variable_ids.length, 0), hydratedVariables: s.variableById.size };
    });
    result.errors = errors;
    result.timings = [];
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    async function measure(name, action) {
      const start = await page.evaluate(() => performance.now());
      await action();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      result.timings.push(await page.evaluate(({ start, name }) => ({ name, ms: performance.now() - start, longestTaskMs: Math.max(0, ...window.__anchorTasks.filter(t => t.at >= start).map(t => t.ms)), rows: document.querySelectorAll('#ivGroupPicker button[data-group-id], #dvGroupPicker button[data-group-id]').length }), { start, name }));
    }
    await measure('first search: education', async () => {
      await page.locator('#ivInput').fill('education');
      await page.waitForFunction(() => ['ready', 'error'].includes(window.__dagBuilderState.variableSearchStatus), null, { timeout: 60000 });
      const failure = await page.evaluate(() => window.__dagBuilderState.variableSearchStatus === 'error' ? String(window.__dagBuilderState.variableSearchError) : null);
      if (failure) throw new Error(failure);
    });
    for (const query of ['income', 'education', 'health', 'e', 'zzzznomatch', '']) {
      await measure(`warm search: ${query || '(clear)'}`, () => page.locator('#ivInput').fill(query));
    }
    result.catalog = await page.evaluate(async () => {
      const builder = document.querySelector('script[type="module"][src*="dag_builder.js"]').src;
      const source = await (await fetch(builder)).text();
      const catalogImport = source.match(/from ["']([^"']*variable_search_catalog\.mjs[^"']*)["']/)[1];
      const { variableSearchCatalog: catalog } = await import(new URL(catalogImport, builder).href);
      const ids = new Set(window.__dagBuilderState.project.groups.flatMap(g => g.variable_ids));
      let constituent = null;
      for (const group of window.__dagBuilderState.project.groups) {
        for (const id of group.variable_ids) {
          const label = catalog.recordById?.get(id)?.[1]?.trim();
          if (label?.length >= 4 && !String(group.label).toLowerCase().includes(label.toLowerCase())) {
            constituent = { groupId: group.group_id, query: label }; break;
          }
        }
        if (constituent) break;
      }
      return { records: catalog.records.length, membersInCatalog: catalog.records.filter(row => ids.has(row[0])).length, constituent };
    });
    if (result.catalog.membersInCatalog !== result.members) throw new Error(`Incomplete catalog coverage: ${JSON.stringify(result.catalog)}`);
    if (!result.catalog.constituent) throw new Error('No constituent search fixture found');
    await page.locator('#ivInput').fill(result.catalog.constituent.query);
    const constituentMatched = await page.evaluate(({ groupId }) => {
      const button = [...document.querySelectorAll('#ivGroupPicker button[data-group-id]')].find(b => b.dataset.groupId === groupId);
      return Boolean(button?.closest('.setup-group-picker-row').querySelector('.setup-group-variable-match'));
    }, result.catalog.constituent);
    if (!constituentMatched) throw new Error('Constituent-only query did not find its group');
    result.constituentSearchPassed = true;
    await page.locator('#ivInput').fill('');
    await page.evaluate(() => { window.__anchorCompiledBefore = window.__dagBuilderState.compiledDag; });
    const anchor = await page.evaluate(() => window.__dagBuilderState.project.groups.find(g => g.variable_ids.length)?.group_id);
    await measure('select IV', async () => {
      await page.locator(`#ivGroupPicker button[data-group-id="${anchor}"]`).click();
      await page.locator('#dvGroupPicker button[data-group-id]').first().waitFor();
    });
    result.compiledDagReused = await page.evaluate(() => window.__anchorCompiledBefore === window.__dagBuilderState.compiledDag);
    if (!result.compiledDagReused) throw new Error('Anchor selection recompiled evidence');
    if (process.env.PROFILE_VERIFY_HISTORY === '1') {
      await page.locator('#dag2UndoBtn').click();
      await page.locator('#ivGroupPicker button[data-group-id]').first().waitFor();
      await page.locator('#redoBtn').dispatchEvent('click');
      await page.waitForFunction(id => window.__dagBuilderState.project.iv_group_id === id, anchor);
      result.historyPassed = true;
    }
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    report.runs.push(result);
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result));
    await context.close();
  }
} finally { await browser.close(); server?.kill(); }
