import { h } from "./dom_builder.mjs";

/**
 * Add ?layout_debug=1 to the address for a small badge that reports what the browser actually did: the page
 * zoom, how much wider than the screen the page is, which element is widest, and the focused field's font size.
 * Phone problems (a page that zooms or overflows) cannot be reproduced in the desktop browsers, so a screenshot
 * of this badge from the phone is the evidence.
 */
export function installLayoutDebug() {
  // The app rewrites the address as you work, so the switch is remembered for the tab.
  try { if (new URLSearchParams(window.location.search).get("layout_debug") === "1") sessionStorage.setItem("echo-layout-debug", "1"); } catch { /* private mode */ }
  let on = false;
  try { on = sessionStorage.getItem("echo-layout-debug") === "1"; } catch { /* private mode */ }
  if (!on) return;
  const badge = h("pre", { className: "layout-debug", attrs: { "aria-hidden": "true" } });
  document.body.append(badge);
  const update = () => {
    const viewport = window.visualViewport;
    const width = window.innerWidth;
    let widest = null;
    for (const element of document.body.querySelectorAll("*")) {
      if (element === badge || !element.offsetParent) continue;
      const right = element.getBoundingClientRect().right;
      if (!widest || right > widest.right) widest = { right, element };
    }
    const active = document.activeElement;
    const label = element => element ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${String(element.className).trim().split(/\s+/)[0] || ""}` : "-";
    badge.textContent = [
      `zoom ${viewport ? viewport.scale.toFixed(2) : "?"}  dpr ${window.devicePixelRatio}`,
      `window ${width}  page ${document.documentElement.scrollWidth}  over ${document.documentElement.scrollWidth - width}`,
      `widest ${label(widest?.element)} → ${widest ? Math.round(widest.right) : "-"}`,
      `focus ${label(active)} ${active && active !== document.body ? getComputedStyle(active).fontSize : ""}`,
      `text-size-adjust ${getComputedStyle(document.documentElement).webkitTextSizeAdjust || "-"}`,
    ].join("\n");
  };
  for (const type of ["resize", "scroll", "focusin", "focusout", "click", "touchend"]) window.addEventListener(type, () => setTimeout(update, 50), true);
  window.visualViewport?.addEventListener("resize", update);
  setInterval(update, 1000);
  update();
}
