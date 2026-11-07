import { h } from "./dom_builder.mjs";

/**
 * A right-click menu on the graph for setting a variable's status. One menu is reused; it closes on a choice,
 * a click elsewhere, Escape, scrolling or resizing.
 */
export function createStatusMenu({ onChoose }) {
  const menu = h("div", { className: "dag-status-menu", attrs: { role: "menu" }, hidden: true });
  document.body.append(menu);

  function hide() {
    menu.hidden = true;
    menu.replaceChildren();
  }

  function show({ title, options, current, clientX, clientY }) {
    menu.replaceChildren(
      h("div", { className: "dag-status-menu-title", textContent: title }),
      ...options.map(option => {
        const item = h("button", { type: "button", className: "dag-status-menu-item", textContent: option.label,
          attrs: { role: "menuitemradio", "aria-checked": String(option.value === current), title: option.title || option.label } });
        item.classList.toggle("is-current", option.value === current);
        item.addEventListener("click", () => { hide(); onChoose(option.value); });
        return item;
      }));
    menu.hidden = false;
    const { offsetWidth: width, offsetHeight: height } = menu;
    menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - height - 4))}px`;
    menu.querySelector(".is-current, .dag-status-menu-item")?.focus();
  }

  document.addEventListener("pointerdown", event => { if (!menu.hidden && !menu.contains(event.target)) hide(); });
  // Escape is consumed here so it does not also step back a screen or close a full-screen panel behind the menu.
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !menu.hidden) { event.preventDefault(); hide(); } });
  window.addEventListener("resize", hide);
  window.addEventListener("wheel", hide, { passive: true });

  return { show, hide };
}
