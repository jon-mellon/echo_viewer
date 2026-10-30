// Real-data evidence-opening regression on the default evidence snapshot.
// Replays a published-schema permalink, then opens several edges the way a
// graph click does. Local source is served on the staging origin; evidence
// requests still use the real snapshot.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { routeProfileSite } from './profile_site_route.mjs';
import { resolve } from 'node:path';

const url = new URL(process.env.PROFILE_URL || 'https://www.jonathanmellon.com/echo_viewer_staging/');
if (url.searchParams.has('local_schema')) throw new Error('Use a published schema URL: local_schema drafts belong to another browser.');
// The default snapshot is deliberately not pinned to a legacy fixture: this gate
// exists to catch a default snapshot that lacks its precomputed evidence assets.
const defaults = {
  p: '1', data_version: '8bf2706808428e59109baa285690135cdbe066e26d97a7d820c9935fc3881849',
  schema: '0970c9ac-0b1c-4cc9-bcb5-12a88cc0e3b9', iv: 'category-academic-achievement',
  dv: 'g_split_1793312497689', mode: 'group_review', path: '1', exclusion_path: '2',
  conf: '1', coll: '0', excl: '0', exog: '0', sparse: '0', bottle: '1', paths: '1', excl_links: '0',
};
for (const [key, value] of Object.entries(defaults)) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
const mobile = process.env.PROFILE_DEVICE === 'mobile';
const output = process.env.PROFILE_OUTPUT || `profile-results-edge-evidence${mobile ? '-mobile' : ''}`;
const root = resolve(process.env.PROFILE_SITE_DIR || 'site');
const remote = process.env.PROFILE_REMOTE === '1';
if (!remote) url.pathname = '/';
const runs = Number(process.env.PROFILE_RUNS || 2);
const edgeCount = Number(process.env.PROFILE_EDGES || 4);
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isSafeInteger(edgeCount) || edgeCount < 2) throw new Error('PROFILE_RUNS and PROFILE_EDGES must be positive integers (edges >= 2)');
// First edge pays for startup; later edges must not pay for remote Parquet or
// label lookups again. Mobile runs at 4x CPU slowdown.
const budgets = { firstEdgeMs: mobile ? 12000 : 6000, nextEdgeMs: mobile ? 2500 : 1000 };
const report = { url: url.href, mobile, cpuThrottle: mobile ? 4 : 1, source: remote ? 'remote deployment' : root, budgets, runs: [] };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let activePage;
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile });
    if (!remote) await routeProfileSite(context, url.href, root);
    const page = await context.newPage(); activePage = page;
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
    await page.addInitScript(() => sessionStorage.setItem('echo-viewer-password-accepted', 'yes'));
    const cdp = await context.newCDPSession(page);
    if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    page.setDefaultTimeout(60000);
    await page.goto(url.href);
    await page.waitForFunction(() => {
      const s = window.__dagBuilderState;
      return s?.compiledDag && !s.compiledDagUpdating && !s.publishedSchemaHydrating && document.getElementById('startupLoading')?.hidden;
    }, null, { timeout: 120000 });
    const hydrated = await page.evaluate(() => Boolean(window.__dagBuilderState.publishedSchemaHydrated));
    if (!hydrated) console.warn('Published schema did not hydrate (see console errors); timing evidence anyway.');
    // Users take a moment before opening evidence; let idle-time engine prewarm run.
    await page.waitForTimeout(Number(process.env.PROFILE_SETTLE_MS || 4000));
    const apiUrl = await page.locator('script[src*="dag_builder.js"]').getAttribute('src');
    const edges = await page.evaluate(async ({ apiUrl, edgeCount, iv }) => {
      const api = await import(apiUrl);
      await api.whenDagRendered();
      const ids = [...api.renderedDagEdgeIds()].filter(id => id !== '__study_design_iv_to_dv__');
      return [...ids.filter(id => id.startsWith(`${iv}__`)), ...ids.filter(id => !id.startsWith(`${iv}__`))].slice(0, edgeCount);
    }, { apiUrl, edgeCount, iv: url.searchParams.get('iv') });
    if (edges.length < edgeCount) throw new Error(`Expected ${edgeCount} rendered edges; found ${edges.length}`);
    const result = { snapshot: url.searchParams.get('data_version'), errors, timings: [] };
    report.runs.push(result);
    for (const [index, edge] of edges.entries()) {
      const timing = await page.evaluate(async ({ apiUrl, edge }) => {
        const api = await import(apiUrl);
        const start = performance.now();
        api.inspectDagEdge(edge);
        const deadline = start + 90000;
        while (performance.now() < deadline) {
          const done = document.querySelector('button[aria-label^="Exclude finding "]') && !window.__dagBuilderState.pendingEdgeEvidence;
          if (done) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return { edge, ms: performance.now() - start, findings: document.querySelectorAll('button[aria-label^="Exclude finding "]').length,
          pending: Boolean(window.__dagBuilderState.pendingEdgeEvidence) };
      }, { apiUrl, edge });
      const budget = index === 0 ? budgets.firstEdgeMs : budgets.nextEdgeMs;
      if (process.env.PROFILE_MEASURES === '1' && index === 0) {
        timing.measures = await page.evaluate(() => performance.getEntriesByType('measure').map(e => ({ name: e.name, start: Math.round(e.startTime), ms: Math.round(e.duration) })));
        timing.resources = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.duration > 100).map(e => ({ url: e.name.split('?')[0].slice(-60), start: Math.round(e.startTime), ms: Math.round(e.duration), kb: Math.round(e.encodedBodySize / 1024) })));
      }
      result.timings.push({ ...timing, budget });
      console.log(JSON.stringify({ run: run + 1, ...timing, budget }));
      if (timing.pending || !timing.findings) throw new Error(`Evidence did not load for ${edge}`);
      if (process.env.PROFILE_DISABLE_BUDGETS !== '1' && timing.ms > budget) throw new Error(`Evidence budget exceeded: ${edge} took ${Math.round(timing.ms)} ms (limit ${budget} ms)`);
    }
    if (errors.length) throw new Error(errors.join('; '));
    await context.close(); activePage = null;
  }
} catch (error) {
  report.error = String(error);
  await activePage?.screenshot({ path: `${output}/failure.png`, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
