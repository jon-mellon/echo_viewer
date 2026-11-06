import test from "node:test";
import assert from "node:assert/strict";
import { attachDagInteractions } from "../site/dag_interactions.mjs";

test("a right-click on a node asks for its status menu and suppresses the browser menu", () => {
  const handlers = new Map(), calls = [];
  const network = {
    on: (name, handler) => handlers.set(name, handler), off: name => handlers.delete(name),
    getNodeAt: point => point.x === 30 ? "candidate" : undefined, unselectAll() {},
  };
  const element = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  attachDagInteractions(network, element, {
    hasGroup: id => id === "candidate", onNodeContext: (id, event) => { calls.push(id); return event.handled; },
  });
  let prevented = 0;
  const event = handled => ({ handled, preventDefault: () => { prevented += 1; } });
  handlers.get("oncontext")({ pointer: { DOM: { x: 30, y: 5 } }, event: event(true) });
  handlers.get("oncontext")({ pointer: { DOM: { x: 30, y: 5 } }, event: event(false) });
  handlers.get("oncontext")({ pointer: { DOM: { x: 99, y: 5 } }, event: event(true) });
  assert.deepEqual(calls, ["candidate", "candidate"]);
  assert.equal(prevented, 1);
});
