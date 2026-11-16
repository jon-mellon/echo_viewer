import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Exercise the action -> synchronous panel open -> capture -> ready-panel
// handoff, which the earlier iframe smoke test never covered.
test('toolbar invocation captures the clicked tab automatically and delivers it to the panel', async () => {
  const source = (await readFile(new URL('../extension/background.mjs', import.meta.url), 'utf8')).replace('import { capturePaper } from "./capture.mjs";', 'const capturePaper = () => {};');
  let action, message; const events = [], deliveries = [];
  const tab = { id: 12, windowId: 3, url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC2796879/' };
  const paper = { title: 'Study', articleText: 'Full text' };
  const chrome = {
    runtime: { id: 'extension', onMessage: { addListener: fn => { message = fn; } }, sendMessage: async value => { deliveries.push(value); } },
    action: { onClicked: { addListener: fn => { action = fn; } } },
    sidePanel: { setPanelBehavior: () => {}, open: options => { events.push(['open', options]); return Promise.resolve(); } },
    tabs: { query: async () => [tab] },
    scripting: { executeScript: async options => { events.push(['capture', options.target.tabId]); return [{ result: paper }]; } }
  };
  runInNewContext(source, { chrome, console });
  action(tab);
  assert.equal(events[0][0], 'open');
  assert.equal(events[1][1], 12);
  const result = await new Promise(resolve => {
    assert.equal(message({ type: 'echo-capture-current', windowId: 3 }, { id: 'extension' }, resolve), true);
  });
  assert.equal(result.paper, paper);
  assert.equal(events.filter(([name]) => name === 'capture').length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(deliveries[0].paper, paper);
  // A refresh uses the newly active article rather than stale captured evidence.
  tab.id = 13;
  await new Promise(resolve => message({ type: 'echo-capture-current', windowId: 3, refresh: true }, { id: 'extension' }, resolve));
  assert.equal(events.at(-1)[1], 13);
  assert.equal(message({ type: 'echo-capture-current', windowId: 3 }, { id: 'other' }, () => {}), undefined);
});
