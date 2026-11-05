// Real-data budgets for variable review and the schema page: setting a disposition,
// opening a graph-claim preview, removing and restoring a variable, the publication
// hash check that follows each decision, opening Edit variable schema, and
// reusing a saved split. Local source is served on the staging origin by
// Playwright; evidence requests still use the real snapshot.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { routeProfileSite } from './profile_site_route.mjs';
import { noteRetry, runRetries } from './profile_run_retry.mjs';
import { resolve } from 'node:path';

const url = new URL(process.env.PROFILE_URL || 'https://www.jonathanmellon.com/echo_viewer_staging/');
if (url.searchParams.has('local_schema')) throw new Error('Use a published schema URL: local_schema drafts belong to another browser.');
const defaults = {
  p: '1', data_version: 'f7666b4f9c4537c3ecfef0e9dc096f00650040e4bd1b2360eea64c1d5fba3f7b',
  schema: 'c221423a-9470-4c82-8a3d-8bcf4a01ef7c', iv: 'category-income-earnings',
  dv: 'category-fertility-reproductive-behavior', task: 'identify', path: '2', conf: '1',
};
for (const [key, value] of Object.entries(defaults)) if (!url.searchParams.has(key)) url.searchParams.set(key, value);
const mobile = process.env.PROFILE_DEVICE !== 'desktop';
const output = process.env.PROFILE_OUTPUT || `profile-results-review${mobile ? '-mobile' : ''}`;
const root = resolve(process.env.PROFILE_SITE_DIR || 'site');
const remote = process.env.PROFILE_REMOTE === '1';
if (!remote) url.pathname = '/';
const runs = Number(process.env.PROFILE_RUNS || 3);
if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('PROFILE_RUNS must be a positive integer');
// Wall time is from the user's action to the settled screen; the mark is the app's own span.
const budgets = {
  disposition: { wallMs: mobile ? 600 : 300 },
  claimPreview: { wallMs: mobile ? 800 : 400 },
  removal: { wallMs: mobile ? 800 : 400 },
  restore: { wallMs: mobile ? 1500 : 800 },
  publicationCompare: { markMs: mobile ? 1500 : 600 },
  schemaPage: { wallMs: mobile ? 1200 : 500 },
  savedSplit: { wallMs: mobile ? 8000 : 4000 },
  longestTaskMs: mobile ? 400 : 200,
};
const report = { url: url.href, mobile, cpuThrottle: mobile ? 4 : 1, source: remote ? 'remote deployment' : root, budgets, runs: [] };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let activePage, activeCdp, profiling = false;
try {
  for (let run = 0; run < runs; run++) {
    for (let attempt = 0; ; attempt++) {
      let context;
      try {
        context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1365, height: 900 }, isMobile: mobile, hasTouch: mobile });
        if (!remote) await routeProfileSite(context, url.href, root);
        const page = await context.newPage(); activePage = page;
        const errors = [];
        page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
        await page.addInitScript(() => {
          sessionStorage.setItem('echo-viewer-password-accepted', 'yes');
          window.__reviewTasks = [];
          window.__reviewObserver = new PerformanceObserver(list => window.__reviewTasks.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration }))));
          window.__reviewObserver.observe({ type: 'longtask', buffered: true });
        });
        const cdp = await context.newCDPSession(page); activeCdp = cdp;
        if (mobile) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
        page.setDefaultTimeout(60000);
        const ready = () => page.waitForFunction(() => {
          const s = window.__dagBuilderState;
          if (document.body.innerText.startsWith('Local schema unavailable')) throw new Error('Local draft unavailable');
          return s?.compiledDag && !s.compiledDagUpdating && s.publishedSchemaHydrated && !s.publishedSchemaHydrating && document.getElementById('startupLoading')?.hidden;
        }, null, { timeout: 120000 });

        // A saved split from an earlier local draft, made from a real source of a few hundred concepts.
        await page.goto(url.href);
        await ready();
        const fixture = await page.evaluate(async () => {
          const s = window.__dagBuilderState;
          const anchors = new Set([s.project.iv_group_id, s.project.dv_group_id]);
          const source = s.project.groups.filter(g => !anchors.has(g.group_id) && g.variable_ids?.length >= 100)
            .sort((a, b) => Math.abs(a.variable_ids.length - 400) - Math.abs(b.variable_ids.length - 400))[0];
          if (!source) throw new Error('No source variable large enough for the saved-split profile');
          const { commitLocalSchema } = await import('/local_schema_store.mjs');
          const half = source.variable_ids.slice(0, Math.floor(source.variable_ids.length / 2));
          await commitLocalSchema({ id: 'profile-saved-split', schema: { groups: [{ group_id: 'profile-saved-split-group',
            label: 'Profile saved split', description: 'A construct saved in an earlier local draft for profiling.', source: 'user_split',
            provenance: { operation: 'split_categories', split_id: 'profile-saved-split-id', source_group_ids: [source.group_id],
              source_group_by_variable: Object.fromEntries(source.variable_ids.map(id => [id, source.group_id])) },
            variable_ids: half }] }, url: location.href });
          return { sourceId: source.group_id, concepts: source.variable_ids.length };
        });
        await page.goto(url.href);
        await ready();
        const apiUrl = await page.locator('script[src*="dag_builder.js"]').getAttribute('src');
        const settled = async () => {
          await page.waitForFunction(() => !window.__dagBuilderState.compiledDagUpdating);
          await page.evaluate(async src => {
            await (await import(src)).whenDagRendered();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, apiUrl);
        };
        const list = async () => { if (mobile) await page.locator('button[data-mobile-panel="controls"]').click(); };
        await list();
        await page.locator('.variable-disposition').first().waitFor();
        const result = { savedSplitSource: fixture, timings: [], errors };
        report.runs.push(result);
        await cdp.send('Profiler.enable'); await cdp.send('Profiler.start'); profiling = true;

        async function measure(name, budget, action, done) {
          // A decision schedules background work (saving it, then hashing the schema against the publication).
          // That work has its own budget below; let it finish so each interaction is measured by itself.
          await page.waitForTimeout(1200);
          const start = await page.evaluate(() => { performance.clearMeasures(); return performance.now(); });
          await action();
          await done();
          const timing = await page.evaluate(({ start, name }) => {
            window.__reviewTasks.push(...window.__reviewObserver.takeRecords().map(e => ({ start: e.startTime, ms: e.duration })));
            const tasks = window.__reviewTasks.filter(t => t.start >= start);
            const marks = Object.fromEntries(performance.getEntriesByType('measure').filter(m => m.name.startsWith('echo:'))
              .map(m => [m.name, Math.round(m.duration)]));
            return { name, ms: Math.round(performance.now() - start), longestTaskMs: Math.round(Math.max(0, ...tasks.map(t => t.ms))), marks };
          }, { start, name });
          result.timings.push(timing);
          console.log(JSON.stringify({ run: run + 1, ...timing }));
          if (process.env.PROFILE_DISABLE_BUDGETS === '1') return timing;
          const over = (budget.wallMs && timing.ms > budget.wallMs) || timing.longestTaskMs > budgets.longestTaskMs;
          if (over) throw new Error(`Performance budget exceeded: ${name} (${timing.ms} ms, longest task ${timing.longestTaskMs} ms)`);
          return timing;
        }
        const menu = index => page.locator('.variable-disposition').nth(index);
        const dialog = page.locator('#variableReviewDialog');

        await measure('disposition: explicitly controlled', budgets.disposition,
          () => menu(0).selectOption('explicitly_controlled'), settled);
        await measure('claim preview: affects outcome only via cause', budgets.claimPreview,
          () => menu(1).selectOption('causes_y_only_via_x'), () => dialog.locator('.review-path, .small-note').first().waitFor());
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        const removedId = await menu(2).getAttribute('data-group-id');
        await menu(2).selectOption('removed_other');
        await dialog.locator('textarea').fill('Outside the study population.');
        await measure('remove variable', budgets.removal,
          () => dialog.getByRole('button', { name: 'Confirm decision' }).click(), settled);
        await measure('restore variable', budgets.restore,
          () => page.locator(`.variable-disposition[data-group-id="${removedId}"]`).selectOption('unaddressed'), settled);
        // Each decision schedules a hash of the working copy against the publication.
        await page.waitForFunction(() => performance.getEntriesByName('echo:publication:compare').length > 0, null, { timeout: 30000 });
        const compareMs = await page.evaluate(() => Math.round(Math.max(...performance.getEntriesByName('echo:publication:compare').map(m => m.duration))));
        result.timings.push({ name: 'publication compare', markMs: compareMs });
        console.log(JSON.stringify({ run: run + 1, name: 'publication compare', markMs: compareMs }));
        if (process.env.PROFILE_DISABLE_BUDGETS !== '1' && compareMs > budgets.publicationCompare.markMs) throw new Error(`Performance budget exceeded: publication compare (${compareMs} ms)`);

        await measure('open Edit variable schema', budgets.schemaPage,
          () => page.locator('#editVariableSchema').click(), () => page.locator('#customVariablesTable tbody tr').first().waitFor());
        await measure('reuse a saved split', budgets.savedSplit,
          () => page.getByRole('button', { name: 'Add Profile saved split to schema' }).click(),
          () => page.waitForFunction(() => document.getElementById('definitionNewLabel')?.value === 'Profile saved split', null, { timeout: 120000 }));

        if (errors.length) throw new Error(errors.join('; '));
        const { profile } = await cdp.send('Profiler.stop'); profiling = false;
        await writeFile(`${output}/cpu-${run}.cpuprofile`, JSON.stringify(profile));
        await writeFile(`${output}/summary.json`, JSON.stringify(report, null, 2));
        await context.close(); activePage = null;
        break;
      } catch (error) {
        if (attempt >= runRetries) throw error;
        noteRetry(report, run, error);
        report.runs.length = run;
        activePage = null;
        profiling = false;
        await context?.close().catch(() => {});
      }
    }
  }
} catch (error) {
  report.error = String(error);
  report.failureState = await activePage?.evaluate(() => ({ text: document.body.innerText.slice(0, 2000) })).catch(() => null);
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
