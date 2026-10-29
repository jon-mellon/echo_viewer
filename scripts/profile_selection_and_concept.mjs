// Profile view-only selection and concept exclusion against a published schema.
// Application files are served from the working tree; immutable data stays remote.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { routeProfileSite } from './profile_site_route.mjs';

const url = new URL(process.env.PROFILE_URL || 'https://www.jonathanmellon.com/echo_viewer_staging/');
url.pathname = '/';
const defaults = { p: '1', data_version: 'f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b', schema: 'c221423a-9470-4c82-8a3d-8bcf4a01ef7c', iv: 'category-income-earnings', dv: 'category-fertility-reproductive-behavior', mode: 'group_review' };
for (const [key, value] of Object.entries(defaults)) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
const mobile = process.env.PROFILE_DEVICE === 'mobile';
const output = process.env.PROFILE_OUTPUT || '/private/tmp/echo-selection-concept-profile';
const runs = Number(process.env.PROFILE_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('PROFILE_RUNS must be a positive integer');
await mkdir(output, { recursive: true });
const report = { url: url.href, mobile, cpuThrottle: mobile ? 4 : 1, runs: [] };
const browser = await chromium.launch({ headless: true });
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile });
    await routeProfileSite(context, url.href, process.env.PROFILE_SITE_DIR || 'site');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
      window.__profileTasks = [];
      window.__profileObserver = new PerformanceObserver(list => window.__profileTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
      window.__profileObserver.observe({ type: 'longtask', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    page.setDefaultTimeout(30000);
    await page.goto(url.href);
    await page.waitForFunction(() => { const s = window.__dagBuilderState; return s?.compiledDag && !s.compiledDagUpdating && s.publishedSchemaHydrated && !s.publishedSchemaHydrating && document.getElementById('startupLoading')?.hidden; }, null, { timeout: 180000 });
    const result = { timings: [], errors }; report.runs.push(result);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    async function settle() {
      await page.waitForFunction(() => !window.__dagBuilderState.compiledDagUpdating);
      await page.evaluate(async () => { const api = await import(document.querySelector('script[src*="dag_builder.js"]').src); await api.whenDagRendered(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    }
    async function measure(name, action) {
      const start = await page.evaluate(() => performance.now());
      await action();
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      const timing = await page.evaluate(({ start, name }) => {
        window.__profileTasks.push(...window.__profileObserver.takeRecords().map(e => ({ start: e.startTime, ms: e.duration })));
        const tasks = window.__profileTasks.filter(t => t.start >= start);
        return { name, ms: performance.now() - start, longestTaskMs: Math.max(0, ...tasks.map(t => t.ms)) };
      }, { start, name });
      result.timings.push(timing); console.log(JSON.stringify({ run: run + 1, ...timing }));
    }
    if (mobile) await page.locator('button[data-mobile-panel="controls"]').click();
    await settle();
    await page.locator('#changeDv').click();
    const dv = await page.locator('#dvGroupPicker button[data-group-id]').first().getAttribute('data-group-id');
    await page.evaluate(() => { window.__profileLinks = window.__dagBuilderState.project.links; });
    await measure('select DV', async () => { await page.locator('#dvGroupPicker button[data-group-id]').first().click(); await page.waitForFunction(id => window.__dagBuilderState.project.dv_group_id === id, dv); });
    if (!await page.evaluate(() => window.__profileLinks === window.__dagBuilderState.project.links)) throw new Error('DV selection re-aggregated links');
    await settle();
    if (mobile) await page.locator('button[data-mobile-panel="controls"]').click();
    await page.locator('#changeInstrument').click();
    const instrument = await page.locator('#instrumentGroupPicker button[data-group-id]').first().getAttribute('data-group-id');
    await page.evaluate(() => { window.__profileLinks = window.__dagBuilderState.project.links; });
    await measure('select instrument', async () => { await page.locator('#instrumentGroupPicker button[data-group-id]').first().click(); await page.waitForFunction(id => window.__dagBuilderState.project.instrument_group_id === id, instrument); });
    if (!await page.evaluate(() => window.__profileLinks === window.__dagBuilderState.project.links)) throw new Error('Instrument selection re-aggregated links');
    await settle();
    if (mobile) await page.locator('button[data-mobile-panel="controls"]').click();
    const item = page.locator('#variablePanelList details').first();
    await measure('open variable', () => item.locator('summary').click());
    const exclude = item.locator('.group-concept-exclude').first();
    await exclude.waitFor({ state: 'visible', timeout: 60000 });
    const groupId = await item.getAttribute('data-group-id');
    const before = await page.evaluate(id => window.__dagBuilderState.project.groups.find(g => g.group_id === id).variable_ids.length, groupId);
    page.once('dialog', dialog => dialog.accept());
    await measure('exclude concept feedback', async () => { await exclude.click(); await page.waitForFunction(({ id, before }) => window.__dagBuilderState.project.groups.find(g => g.group_id === id).variable_ids.length === before - 1, { id: groupId, before }); });
    await measure('exclude concept graph settled', settle);
    if (errors.length) throw new Error(errors.join('; '));
    const { profile } = await cdp.send('Profiler.stop');
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    await context.close();
  }
} catch (error) { report.error = String(error); throw error; }
finally { await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2)); await browser.close(); }
