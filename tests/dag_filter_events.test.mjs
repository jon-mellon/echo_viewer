import test from 'node:test';
import assert from 'node:assert/strict';
import { createDagEventController } from '../site/dag_event_controller.mjs';
import { createDagAppState } from '../site/dag_app_state.mjs';

test('diagnostic controls update the view without rebuilding or saving the project', () => {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, { handlers: new Map(), value: '3',
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      querySelectorAll() { return []; },
    });
    return elements.get(id);
  }
  const state = createDagAppState(); state.map.canvas = element('canvas');
  const calls = [];
  globalThis.document = { addEventListener() {}, getElementById() { return null; } };
  globalThis.window = { addEventListener() {} };
  try {
    createDagEventController({ state,
      elements: new Proxy({}, { get: (_, id) => element(id) }),
      updateDagFilters: () => calls.push('filter'),
      rebuildProject: () => calls.push('rebuild'),
      saveProjectLocally: () => calls.push('save'),
      installDagHandlers() {}, initPanelResizers() {},
      clampNumber: (n, min, max) => Math.min(max, Math.max(min, n)),
    }).installHandlers();
    for (const [id, event] of [
      ['toggleExclusionViolations', 'click'], ['toggleExogeneity', 'click'],
      ['showUnfiltered', 'click'], ['toggleConfoundersOnly', 'click'],
      ['toggleCollidersOnly', 'click'], ['confounderPathLength', 'input'],
      ['toggleSparseEdges', 'click'], ['minimumEdgePapers', 'input'],
      ['toggleBottleneckedConfounders', 'click'], ['toggleIrrelevantConfounderLinks', 'click'],
      ['toggleAllExclusionLinks', 'click'],
    ]) {
      calls.length = 0;
      element(id).handlers.get(event)();
      assert.deepEqual(calls, ['filter'], `${id} must only update graph filters`);
      if (id === 'toggleExclusionViolations') {
        assert.equal(state.showExclusionViolations, true); assert.equal(state.showExogeneity, false);
      }
      if (id === 'toggleExogeneity') {
        assert.equal(state.showExogeneity, true); assert.equal(state.showExclusionViolations, false);
      }
    }
    assert.equal(state.confounderMaxPathLength, 3);
  } finally { globalThis.document = previousDocument; globalThis.window = previousWindow; }
});
