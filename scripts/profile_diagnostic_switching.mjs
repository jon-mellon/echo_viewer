// Real-data diagnostic switching regression. Local source is served on the
// staging origin by Playwright; evidence requests still use the real snapshot.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { routeProfileSite } from './profile_site_route.mjs';
import { resolve } from 'node:path';

const url = new URL(process.env.PROFILE_URL || 'https://www.jonathanmellon.com/echo_viewer_staging/');
if (url.searchParams.has('local_schema')) throw new Error('Use a published schema URL: local_schema drafts belong to another browser.');
const defaults = {
  p: '1', data_version: 'f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b',
  schema: 'c221423a-9470-4c82-8a3d-8bcf4a01ef7c', iv: 'category-income-earnings',
  dv: 'category-fertility-reproductive-behavior', instrument: 'category-weather',
  path: '1', exclusion_path: '2', conf: '0', coll: '0', excl: '0', exog: '1',
  sparse: '0', bottle: '1', paths: '1', excl_links: '0',
};
for (const [key, value] of Object.entries(defaults)) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
url.searchParams.set('mode', 'group_review');
const mobile = process.env.PROFILE_DEVICE !== 'desktop';
const output = process.env.PROFILE_OUTPUT || `profile-results-diagnostics${mobile ? '-mobile' : ''}`;
const root = resolve(process.env.PROFILE_SITE_DIR || 'site');
const remote = process.env.PROFILE_REMOTE === '1';
if (!remote) url.pathname = '/';
const runs = Number(process.env.PROFILE_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('PROFILE_RUNS must be a positive integer');
const budgets = { wallMs: mobile ? 500 : 250, longestTaskMs: mobile ? 100 : 75 };
const report = { url: url.href, mobile, cpuThrottle: mobile ? 4 : 1, source: remote ? 'remote deployment' : root, budgets, runs: [] };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let activePage, activeCdp, profiling = false;
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile });
    if (!remote) await routeProfileSite(context, url.href, root);
    const page = await context.newPage(); activePage = page;
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    page.on('requestfailed', request => console.error('Request failed:', request.url(), request.failure()?.errorText));
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
      window.__diagnosticTasks = [];
      window.__diagnosticObserver = new PerformanceObserver(list => window.__diagnosticTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
      window.__diagnosticObserver.observe({ type: 'longtask', buffered: true });
    });
    const cdp = await context.newCDPSession(page); activeCdp = cdp;
    if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    page.setDefaultTimeout(30000);
    await page.goto(url.href);
    await page.waitForFunction(() => {
      const s = window.__dagBuilderState;
      if (document.body.innerText.startsWith('Local schema unavailable')) throw new Error('Local draft unavailable');
      return s?.compiledDag && !s.compiledDagUpdating && s.publishedSchemaHydrated && !s.publishedSchemaHydrating && document.getElementById('startupLoading')?.hidden;
    }, null, { timeout: 120000 });
    const apiUrl = await page.locator('script[src*="dag_builder.js"]').getAttribute('src');
    async function settled() {
      await page.waitForFunction(() => !window.__dagBuilderState.compiledDagUpdating);
      await page.evaluate(async src => {
        await (await import(src)).whenDagRendered();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, apiUrl);
    }
    if (mobile) await page.locator('[data-mobile-panel="dag"]').click();
    await settled();
    await page.locator('.filter-dropdown > summary').click();
    await page.evaluate(() => {
      const s = window.__dagBuilderState;
      window.__diagnosticBaseline = { compiled: s.compiledDag, links: s.project.links, groups: s.project.groups, evidence: s.rawLinksById.size };
    });
    const result = { timings: [], errors };
    report.runs.push(result);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); profiling = true;
    async function measure(name, id, expectedMode) {
      const start = await page.evaluate(() => performance.now());
      await page.locator(`#${id}`).click();
      await settled();
      const timing = await page.evaluate(async ({ start, name, apiUrl, expectedMode }) => {
        const s = window.__dagBuilderState, baseline = window.__diagnosticBaseline;
        if (s.compiledDag !== baseline.compiled || s.project.links !== baseline.links || s.project.groups !== baseline.groups) throw new Error('View filter rebuilt the project');
        if (s.rawLinksById.size !== baseline.evidence) throw new Error('View switch loaded raw evidence');
        if (expectedMode && !s[expectedMode]) throw new Error(`Wrong diagnostic mode: ${expectedMode}`);
        const api = await import(apiUrl), rendered = new Set(api.renderedDagEdgeIds());
        const expected = s.visibleLinks.filter(link => !link.is_target_relation && s.componentGroupIds.has(link.group_a) && s.componentGroupIds.has(link.group_b)).map(link => link.edge_id);
        if (!expected.length) throw new Error('Expected a nonempty diagnostic graph');
        if (expected.some(id => !rendered.has(id))) throw new Error('Visible evidence missing from rendered graph');
        const projectIds = new Set(s.project.links.filter(l => !l.is_target_relation).map(l => l.edge_id));
        const expectedIds = new Set(expected);
        if ([...rendered].some(id => projectIds.has(id) && !expectedIds.has(id))) throw new Error('Stale evidence remains rendered');
        // Drain pending observer records after the two paint frames.
        window.__diagnosticTasks.push(...window.__diagnosticObserver.takeRecords().map(e => ({ start: e.startTime, ms: e.duration })));
        const tasks = window.__diagnosticTasks.filter(t => t.start >= start);
        return { name, ms: performance.now() - start, longestTaskMs: Math.max(0, ...tasks.map(t => t.ms)), totalLongTaskMs: tasks.reduce((n, t) => n + t.ms, 0), visibleEdges: expected.length };
      }, { start, name, apiUrl, expectedMode });
      result.timings.push(timing);
      console.log(JSON.stringify({ run: run + 1, ...timing }));
      if (process.env.PROFILE_DISABLE_BUDGETS !== '1' && (timing.ms > budgets.wallMs || timing.longestTaskMs > budgets.longestTaskMs)) throw new Error(`Performance budget exceeded: ${name}`);
    }
    // First switch exercises cold geometry; later switches exercise both cached views.
    for (let cycle = 0; cycle < 3; cycle++) {
      await measure(`exclusion ${cycle + 1}`, 'toggleExclusionViolations', 'showExclusionViolations');
      await measure(`exogeneity ${cycle + 1}`, 'toggleExogeneity', 'showExogeneity');
    }
    await measure('bottleneck filter', 'toggleBottleneckedConfounders', 'showExogeneity');
    await measure('path links filter', 'toggleIrrelevantConfounderLinks', 'showExogeneity');
    await measure('return to exclusion', 'toggleExclusionViolations', 'showExclusionViolations');
    await measure('all exclusion links', 'toggleAllExclusionLinks', 'showExclusionViolations');
    if (errors.length) throw new Error(errors.join('; '));
    const { profile } = await cdp.send('Profiler.stop'); profiling = false;
    await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
    await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
    await context.close(); activePage = null;
  }
} catch (error) {
  report.error = String(error);
  report.failureState = await activePage?.evaluate(() => ({ text: document.body.innerText.slice(0, 2000), scripts: [...document.scripts].map(s => s.src) })).catch(() => null);
  if (profiling) {
    const stopped = await activeCdp.send('Profiler.stop').catch(() => null);
    if (stopped) await writeFile(`${output}/failure.cpuprofile`, JSON.stringify(stopped.profile));
  }
  await activePage?.screenshot({ path: `${output}/failure.png`, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
