// Arrow-key movement through a long list of choices, so a keyboard user does not Tab through every row.
const PAGE = 10;

/** Index to focus after `key`, or null when the key is not a list-navigation key. `current` is -1 when focus is outside the list. */
export function listNavTarget(key, current, count) {
  if (!count) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowDown": return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp": return current < 0 ? last : Math.max(current - 1, 0);
    case "PageDown": return Math.min(Math.max(current, 0) + PAGE, last);
    case "PageUp": return Math.max(current - PAGE, 0);
    case "Home": return 0;
    case "End": return last;
    default: return null;
  }
}

/** Screen-reader text for the number of choices a search leaves. */
export function resultCountText(count, noun = "variable") {
  return count === 0 ? `No ${noun}s match` : `${count} ${noun}${count === 1 ? "" : "s"} ${count === 1 ? "matches" : "match"}`;
}

/**
 * Up/Down/PageUp/PageDown/Home/End move between `rowSelector` buttons in `container`; Escape in the list returns to the input from `getInput`;
 * ArrowDown in the input enters the list (bind the returned handler to it). Home/End stay with the text field while it has focus. When rows carry a second
 * control (`itemSelector` wraps a row and its `detailSelector`, such as a definition), Right/Left move between the two.
 */
export function attachListKeyboardNav(container, { getInput = () => null, rowSelector, itemSelector = null, detailSelector = null }) {
  const rows = () => [...container.querySelectorAll(rowSelector)];
  const onKeydown = event => {
    const input = getInput();
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const list = rows();
    const inInput = input && event.target === input;
    if (itemSelector && detailSelector && !inInput && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      const item = event.target.closest?.(itemSelector);
      const detail = item?.querySelector(detailSelector);
      const row = item && list.find(node => item.contains(node));
      const next = event.key === "ArrowRight" && event.target === row ? detail : event.key === "ArrowLeft" && event.target === detail ? row : null;
      if (next) { event.preventDefault(); next.focus(); }
      return;
    }
    if (event.key === "Escape" && !inInput && input && event.target.closest?.(itemSelector || rowSelector)) { event.preventDefault(); input.focus(); return; }
    if (inInput && event.key !== "ArrowDown") return;
    if (!inInput && !list.includes(event.target)) return;
    if (event.key === "ArrowUp" && list[0] === event.target && input) { event.preventDefault(); input.focus(); return; }
    const target = listNavTarget(event.key, list.indexOf(event.target), list.length);
    if (target === null) return;
    event.preventDefault();
    list[target].focus();
    list[target].scrollIntoView?.({ block: "nearest" });
  };
  container.addEventListener("keydown", onKeydown);
  return onKeydown;
}
