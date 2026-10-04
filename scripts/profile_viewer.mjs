import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const url = process.env.PROFILE_URL || "http://127.0.0.1:8767/";
const mobile = process.env.PROFILE_DEVICE === "mobile";
const output = process.env.PROFILE_OUTPUT || (mobile ? "profile-results-mobile" : "profile-results");
const local = !process.env.PROFILE_URL;
const started = new Date().toISOString();
const results = { started, url, device: mobile ? "mobile" : "desktop", scenarios: [], errors: [] };
const scenarioBudgets = {
  "open variable definition": 750,
  "select definition source": 4000,
  "variable map zoom": 500,
  "close variable definition": 750,
  "group search": 2000,
  "select IV": 750,
  "select DV": 1000,
  "DAG layout: hierarchical": 750,
  "DAG layout: organic": 750,
  "DAG layout: auto": 750,
  "DAG zoom": 500,
  "causal filter": 1000,
};
let server, browser, context, page, cdp;

function round(value) { return Math.round(value * 10) / 10; }
async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch { /* server starting */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Preview server did not start at ${url}`);
}

async function snapshot() {
  return page.evaluate(() => ({
    at: performance.now(),
    longTasks: [...window.__profile.longTasks],
    events: [...window.__profile.events],
    frameGaps: [...window.__profile.frameGaps],
    resources: performance.getEntriesByType("resource").map(entry => ({
      name: entry.name, startTime: entry.startTime, duration: Math.max(0, entry.duration), transferSize: entry.transferSize,
      decodedBodySize: entry.decodedBodySize,
    })),
    measures: performance.getEntriesByType("measure").filter(entry => entry.name.startsWith("echo:"))
      .map(entry => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })),
    navigation: performance.getEntriesByType("navigation")[0]?.toJSON(),
    paints: performance.getEntriesByType("paint").map(entry => ({ name: entry.name, startTime: entry.startTime })),
    lcp: window.__profile.lcp,
    cls: window.__profile.cls,
    layoutShifts: window.__profile.layoutShifts,
    heap: performance.memory?.usedJSHeapSize ?? null,
  }));
}

async function measure(name, action) {
  const before = await snapshot();
  const startedAt = Date.now();
  await action();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const after = await snapshot();
  const longTasks = after.longTasks.filter(entry => entry.startTime >= before.at);
  const events = after.events.filter(entry => entry.startTime >= before.at);
  const frameGaps = after.frameGaps.filter(entry => entry.at >= before.at);
  const resources = after.resources.filter(entry => entry.startTime >= before.at);
  const measures = after.measures.filter(entry => entry.startTime >= before.at);
  results.scenarios.push({ name, wallMs: Date.now() - startedAt,
    browserMs: round(after.at - before.at),
    longTaskMs: round(longTasks.reduce((sum, entry) => sum + entry.duration, 0)),
    longestTaskMs: round(Math.max(0, ...longTasks.map(entry => entry.duration))),
    longestEventMs: round(Math.max(0, ...events.map(entry => entry.duration))),
    maxFrameGapMs: round(Math.max(0, ...frameGaps.map(entry => entry.ms))),
    requestCount: resources.length,
    transferMB: round(resources.reduce((sum, entry) => sum + entry.transferSize, 0) / 1048576),
    slowestRequests: resources.sort((a, b) => b.duration - a.duration).slice(0, 3)
      .map(entry => ({ name: entry.name, durationMs: round(entry.duration) })),
    appMeasures: measures.map(entry => ({ name: entry.name, durationMs: round(entry.duration) })),
    heapMB: after.heap == null ? null : round(after.heap / 1048576),
  });
}

try {
  await mkdir(output, { recursive: true });
  if (local) {
    server = spawn("python3", ["-m", "http.server", "8767", "--directory", "site"], { stdio: "ignore" });
    await waitForServer();
  }
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 }
    : { width: 1365, height: 900 }, deviceScaleFactor: 1,
  isMobile: mobile, hasTouch: mobile });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  page.on("pageerror", error => results.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") results.errors.push(message.text()); });
  await page.addInitScript(() => {
    sessionStorage.setItem("echo-viewer-password-accepted", "yes");
    const profile = window.__profile = { longTasks: [], events: [], frameGaps: [], layoutShifts: [], lcp: null, cls: 0 };
    for (const type of ["longtask", "event", "largest-contentful-paint", "layout-shift"]) {
      try {
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (type === "longtask") profile.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
            if (type === "event") profile.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
            if (type === "largest-contentful-paint") profile.lcp = entry.startTime;
            if (type === "layout-shift" && !entry.hadRecentInput) {
              profile.cls += entry.value;
              profile.layoutShifts.push({ at: entry.startTime, value: entry.value,
                sources: (entry.sources || []).map(source => ({
                  element: source.node?.id || source.node?.className || source.node?.tagName || "unknown",
                  previousRect: source.previousRect, currentRect: source.currentRect,
                })) });
            }
          }
        }).observe({ type, buffered: true, ...(type === "event" ? { durationThreshold: 16 } : {}) });
      } catch { /* unsupported entry type */ }
    }
    let prior = 0;
    function frame(at) {
      if (prior && at - prior > 50) profile.frameGaps.push({ at, ms: at - prior });
      prior = at;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  cdp = await context.newCDPSession(page);
  if (mobile) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  const startupAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__dagBuilderState?.compiledDag
    && document.getElementById("startupLoading")?.hidden, null, { timeout: 90000 });
  const visibleMs = Date.now() - startupAt;
  await page.waitForFunction(() => window.__dagBuilderState?.publishedSchemaHydrated
    && !window.__dagBuilderState?.publishedSchemaHydrating, null, { timeout: 90000 });
  const startup = await snapshot();
  results.startup = {
    visibleMs,
    schemaReadyMs: Date.now() - startupAt,
    domContentLoadedMs: round(startup.navigation?.domContentLoadedEventEnd ?? 0),
    lcpMs: startup.lcp == null ? null : round(startup.lcp),
    cls: Math.round(startup.cls * 1000) / 1000,
    layoutShifts: startup.layoutShifts,
    longTaskMs: round(startup.longTasks.reduce((sum, entry) => sum + entry.duration, 0)),
    longestTaskMs: round(Math.max(0, ...startup.longTasks.map(entry => entry.duration))),
    resourceCount: startup.resources.length,
    transferMB: round(startup.resources.reduce((sum, entry) => sum + entry.transferSize, 0) / 1048576),
    largestResources: startup.resources.sort((a, b) => b.transferSize - a.transferSize).slice(0, 8)
      .map(entry => ({ name: entry.name, transferMB: round(entry.transferSize / 1048576), durationMs: round(entry.duration) })),
  };

  await measure("open variable definition", async () => {
    await page.locator('#ivGroupPicker button[data-define-side="iv"]').click();
    await page.locator("#definitionSourceList input[data-source-id]").first().waitFor();
  });
  const sourceGroupId = await page.locator("#definitionSourceList input[data-source-id]").first()
    .getAttribute("data-source-id");
  await measure("select definition source", async () => {
    await page.locator("#definitionSourceList input[data-source-id]").first().check();
    await page.locator("#definitionContinue").click();
    if (mobile) await page.locator('button[data-mobile-panel="variables"]').click();
    await page.locator("#dagZoomIn").waitFor({ state: "visible" });
    const loaded = await page.evaluate(groupId => {
      const state = window.__dagBuilderState;
      const ids = state.project.groups.find(group => group.group_id === groupId)?.variable_ids || [];
      return { total: ids.length, missing: ids.filter(id => !state.variableById.has(id)).length };
    }, sourceGroupId);
    if (!loaded.total || loaded.missing) throw new Error(`Definition metadata missing for ${loaded.missing}/${loaded.total} variables`);
  });
  await measure("variable map zoom", async () => {
    await page.locator("#dagZoomIn").click();
  });
  await measure("close variable definition", async () => {
    if (mobile) await page.locator('button[data-mobile-panel="controls"]').click();
    await page.locator("#definitionCancel").click();
  });

  await measure("group search", async () => {
    await page.locator("#ivInput").fill("education");
    await page.waitForFunction(() => window.__dagBuilderState.variableSearchStatus === "ready", null,
      { timeout: 30000 });
  });
  await page.locator("#ivInput").fill("");
  const anchors = await page.evaluate(() => window.__dagBuilderState.project.groups
    .filter(group => group.variable_ids?.length).slice(0, 2).map(group => group.group_id));
  if (anchors.length < 2) throw new Error("The sample schema has fewer than two populated groups");
  await measure("select IV", async () => {
    await page.locator(`#ivGroupPicker button[data-group-id="${anchors[0]}"]`).click();
    await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).waitFor();
  });
  await measure("select DV", async () => {
    await page.locator(`#dvGroupPicker button[data-group-id="${anchors[1]}"]`).click();
    await page.waitForFunction(() => window.__dagBuilderState?.project?.dv_group_id != null);
  });
  if (mobile) await page.locator('button[data-mobile-panel="dag"]').click();
  for (const mode of ["hierarchical", "organic", "auto"]) {
    await measure(`DAG layout: ${mode}`, async () => {
      await page.locator("#dagLayoutSelect").selectOption(mode);
      await page.waitForFunction(expected => window.__dagBuilderState.dagLayoutMode === expected, mode);
    });
  }
  await measure("DAG zoom", async () => {
    await page.locator("#dagSvgZoomIn").click();
  });
  await measure("causal filter", async () => {
    await page.locator("#toggleCausalFilter").click();
  });
  results.budgetFailures = [
    ...results.scenarios.flatMap(scenario => [
      ...(scenario.wallMs > scenarioBudgets[scenario.name] * (mobile ? 4 : 1)
        ? [`${scenario.name}: ${scenario.wallMs} ms exceeds ${scenarioBudgets[scenario.name] * (mobile ? 4 : 1)} ms`] : []),
      ...(scenario.longestTaskMs > (mobile ? 500 : 150)
        ? [`${scenario.name}: ${scenario.longestTaskMs} ms task exceeds ${mobile ? 500 : 150} ms`] : []),
      ...(scenario.longestEventMs > (mobile ? 400 : 150)
        ? [`${scenario.name}: ${scenario.longestEventMs} ms event exceeds ${mobile ? 400 : 150} ms`] : []),
    ]),
    ...(results.startup.visibleMs > (mobile ? 20000 : 12000) ? [`Startup visible time ${results.startup.visibleMs} ms exceeds ${mobile ? 20000 : 12000} ms`] : []),
    ...(results.startup.schemaReadyMs > (mobile ? 30000 : 20000) ? [`Schema ready time ${results.startup.schemaReadyMs} ms exceeds ${mobile ? 30000 : 20000} ms`] : []),
    ...(results.startup.lcpMs == null || results.startup.lcpMs > (mobile ? 18000 : 9000)
      ? [`Startup LCP ${results.startup.lcpMs} ms exceeds ${mobile ? 18000 : 9000} ms`] : []),
    ...(results.startup.longestTaskMs > (mobile ? 600 : 250)
      ? [`Startup ${results.startup.longestTaskMs} ms task exceeds ${mobile ? 600 : 250} ms`] : []),
    ...(results.startup.transferMB > 2.5 ? [`Startup transfer ${results.startup.transferMB} MB exceeds 2.5 MB`] : []),
    ...(results.startup.cls > 0.1 ? [`Startup CLS ${results.startup.cls} exceeds 0.1`] : []),
    ...results.errors.map(error => `Browser error: ${error}`),
  ];
  if (results.budgetFailures.length && process.env.PROFILE_DISABLE_BUDGETS !== "1") process.exitCode = 1;
  const cpu = await cdp.send("Profiler.stop");
  await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(cpu.profile));
  results.finished = new Date().toISOString();
  await writeFile(join(output, "summary.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ device: results.device, startup: { visibleMs: results.startup.visibleMs,
    schemaReadyMs: results.startup.schemaReadyMs, transferMB: results.startup.transferMB,
    cls: results.startup.cls },
  scenarios: results.scenarios.map(scenario => ({ name: scenario.name, wallMs: scenario.wallMs,
    longestTaskMs: scenario.longestTaskMs })), budgetFailures: results.budgetFailures }, null, 2));
} catch (error) {
  results.failure = String(error?.stack || error);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "summary.json"), JSON.stringify(results, null, 2));
  console.error(results.failure);
  process.exitCode = 1;
} finally {
  if (context) await context.tracing.stop({ path: join(output, "playwright-trace.zip") }).catch(() => {});
  await browser?.close().catch(() => {});
  server?.kill();
}
