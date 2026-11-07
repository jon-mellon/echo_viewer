import test from "node:test";
import assert from "node:assert/strict";
import { attachListKeyboardNav, listNavTarget, resultCountText } from "../site/list_keyboard_nav.mjs";

test("arrow, page, Home and End keys move through a long list without wrapping", () => {
  assert.equal(listNavTarget("ArrowDown", -1, 110), 0);
  assert.equal(listNavTarget("ArrowDown", 109, 110), 109);
  assert.equal(listNavTarget("ArrowUp", 0, 110), 0);
  assert.equal(listNavTarget("PageDown", 5, 110), 15);
  assert.equal(listNavTarget("PageDown", 105, 110), 109);
  assert.equal(listNavTarget("PageUp", 4, 110), 0);
  assert.equal(listNavTarget("Home", 50, 110), 0);
  assert.equal(listNavTarget("End", 50, 110), 109);
  assert.equal(listNavTarget("a", 50, 110), null);
  assert.equal(listNavTarget("ArrowDown", -1, 0), null);
});

test("result counts read as sentences", () => {
  assert.equal(resultCountText(0), "No variables match");
  assert.equal(resultCountText(1), "1 variable matches");
  assert.equal(resultCountText(110, "group"), "110 groups match");
});

function fakeNode(name, { matches = [], parent = null } = {}) {
  const node = { name, parent, focused: 0, children: [], listeners: {},
    focus() { node.focused++; node.log.push(name); }, scrollIntoView() {},
    contains(other) { return other === node || node.children.some(child => child.contains(other)); },
    closest(selector) { for (let at = node; at; at = at.parent) if (at.matches.includes(selector)) return at; return null; },
    querySelector(selector) { return node.children.find(child => child.matches.includes(selector)) || null; },
    matches };
  return node;
}

test("keys move focus between rows, into their definition and back to the search field", () => {
  const log = [];
  const make = (name, matches, parent) => { const node = fakeNode(name, { matches, parent }); node.log = log; parent?.children.push(node); return node; };
  const container = make("container", []);
  container.querySelectorAll = selector => selector === "row" ? items.map(item => item.children[0]) : [];
  const items = [0, 1, 2].map(i => {
    const item = make(`item${i}`, ["item"], container);
    make(`row${i}`, ["row"], item);
    make(`info${i}`, ["info"], item);
    return item;
  });
  const input = make("input", []);
  container.listeners = {};
  container.addEventListener = (type, fn) => { container.listeners[type] = fn; };
  const handler = attachListKeyboardNav(container, { getInput: () => input, rowSelector: "row", itemSelector: "item", detailSelector: "info" });
  const press = (target, key) => { let prevented = false; handler({ key, target, preventDefault() { prevented = true; } }); return prevented; };
  const rows = items.map(item => item.children[0]);

  assert.equal(press(input, "ArrowDown"), true);
  assert.equal(log.at(-1), "row0");
  press(rows[0], "ArrowDown"); assert.equal(log.at(-1), "row1");
  press(rows[1], "ArrowRight"); assert.equal(log.at(-1), "info1");
  press(items[1].children[1], "ArrowLeft"); assert.equal(log.at(-1), "row1");
  press(rows[1], "End"); assert.equal(log.at(-1), "row2");
  press(rows[2], "Escape"); assert.equal(log.at(-1), "input");
  press(rows[0], "ArrowUp"); assert.equal(log.at(-1), "input");
  assert.equal(press(input, "ArrowUp"), false, "typing keys in the search field are left alone");
  assert.equal(press(input, "Home"), false);
});
