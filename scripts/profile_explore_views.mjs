// Real-data budgets for the causes and consequences views. Local source is
// served on the staging origin by Playwright; evidence requests use the real
// snapshot. The first focus may wait for per-finding paper support (the same
// records the sparse-edge filter loads); later interactions must stay quick.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { routeProfileSite } from './profile_site_route.mjs';

const url = new URL(process.env.PROFILE_URL || 'https://www.jonathanmellon.com/echo_viewer_staging/');
url.search = '';
url.searchParams.set('task', 'causes');
const mobile = process.env.PROFILE_DEVICE !== 'desktop';
const output = process.env.PROFILE_OUTPUT || `profile-results-explore${mobile ? '-mobile' : ''}`;
const root = resolve(process.env.PROFILE_SITE_DIR || 'site');
const remote = process.env.PROFILE_REMOTE === '1';
if (!remote) url.pathname = '/';
const runs = Number(process.env.PROFILE_RUNS || 2);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('PROFILE_RUNS must be a positive integer');
// Mobile runs at 4x CPU slowdown.
// Local runs measured about 150 ms (mobile) and 120 ms (desktop) per
// interaction; the budgets leave room for slower CI runners.
const budgets = { firstResultsMs: mobile ? 20000 : 10000, interactionMs: mobile ? 500 : 300, longestTaskMs: mobile ? 150 : 100 };
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
    await page.addInitScript(() => {
      sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
      window.__exploreTasks = [];
      window.__exploreObserver = new PerformanceObserver(list => window.__exploreTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
      window.__exploreObserver.observe({ type: 'longtask', buffered: true });
    });
    const cdp = await context.newCDPSession(page);
    if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    page.setDefaultTimeout(60000);
    await page.goto(url.href);
    await page.waitForFunction(() => window.__dagBuilderState?.project?.links?.length > 100
      && document.getElementById('startupLoading')?.hidden && !document.getElementById('exploreView').hidden, null, { timeout: 120000 });
    const result = { errors, timings: [] };
    report.runs.push(result);
    async function measure(name, action, budget = budgets.interactionMs) {
      const start = await page.evaluate(() => performance.now());
      await action();
      const timing = await page.evaluate(async ({ start, name }) => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__exploreTasks.push(...window.__exploreObserver.takeRecords().map(e => ({ start: e.startTime, ms: e.duration })));
        const tasks = window.__exploreTasks.filter(t => t.start >= start);
        return { name, ms: performance.now() - start, longestTaskMs: Math.max(0, ...tasks.map(t => t.ms)),
          rows: document.querySelectorAll('.explore-row').length, summary: document.getElementById('exploreSummary').textContent };
      }, { start, name });
      result.timings.push({ ...timing, budget });
      console.log(JSON.stringify({ run: run + 1, ...timing, budget }));
      if (!timing.rows) throw new Error(`No results after ${name}: ${timing.summary}`);
      if (process.env.PROFILE_DISABLE_BUDGETS !== '1'
        && (timing.ms > budget || (budget === budgets.interactionMs && timing.longestTaskMs > budgets.longestTaskMs))) {
        throw new Error(`Explore budget exceeded: ${name} took ${Math.round(timing.ms)} ms, longest task ${Math.round(timing.longestTaskMs)} ms`);
      }
    }
    // Optional: simulate time spent choosing, during which paper support loads.
    if (Number(process.env.PROFILE_PICK_DELAY_MS) > 0) await page.waitForTimeout(Number(process.env.PROFILE_PICK_DELAY_MS));
    await measure('choose focus (cold, includes paper support)', async () => {
      await page.locator('.explore-pick[data-group-id="category-mental-health"]').click();
      await page.locator('.explore-row').first().waitFor({ timeout: 90000 });
    }, budgets.firstResultsMs);
    for (const depth of [2, 3, 4, 1]) {
      await measure(`distance ${depth}`, () => page.locator(`#exploreDepth button[data-depth="${depth}"]`).click());
    }
    await measure('min papers 5', () => page.locator('#exploreMinPapers').selectOption('5'));
    await measure('switch to consequences', async () => {
      await page.locator('#taskBar .task-tab[data-task=consequences]').click();
      await page.locator('.explore-pick[data-group-id="category-income-earnings"]').click();
    });
    await measure('consequences distance 4', () => page.locator('#exploreDepth button[data-depth="4"]').click());
    await measure('drill into a result', () => page.locator('.explore-row-label').first().click());
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
