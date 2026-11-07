import { h } from "./dom_builder.mjs";

// Source data writes concepts with "uoa" standing for the unit of analysis
// ("uoa's self-reported amusement"). The abbreviation stays, and its first
// use on a screen opens a short explanation on hover, focus or tap.
export const UOA_HINT = "UOA = unit of analysis: the kind of entity a concept describes, such as a person, patient or country. "
  + "\"uoa's self-reported amusement\" means the self-reported amusement of the entity being studied.";

function uoaHint(word) {
  const popover = h("span", { className: "uoa-hint-popover", role: "tooltip", hidden: true, textContent: UOA_HINT });
  const button = h("button", { className: "uoa-hint", type: "button", textContent: word,
    attrs: { "aria-expanded": "false", "aria-label": `${word}: what is this?` } });
  const wrap = h("span", { className: "uoa-hint-wrap" }, button, popover);
  // One outside-dismiss handler per hint, detached whenever it closes. Closing from the button used to leave
  // the document listeners behind, so each reopen stacked another pair and kept this hint's DOM alive.
  const close = event => {
    if (event.type === "keydown") {
      if (event.key !== "Escape") return;
      // Escape closes the hint only, not the screen behind it.
      event.preventDefault();
    } else if (wrap.contains(event.target)) return;
    setOpen(false);
  };
  const setOpen = open => {
    popover.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    document.removeEventListener("click", close);
    document.removeEventListener("keydown", close);
    if (open) {
      document.addEventListener("click", close);
      document.addEventListener("keydown", close);
    }
  };
  button.addEventListener("click", () => setOpen(popover.hidden));
  return wrap;
}

/** Text as child nodes, with the first "uoa" of the screen followed by its explanation. */
export function conceptWithUoaHint(text, hint) {
  const value = String(text ?? "");
  const match = hint.shown ? null : /\buoa\b/i.exec(value);
  if (!match) return [value];
  hint.shown = true;
  return [value.slice(0, match.index), uoaHint(match[0]), value.slice(match.index + match[0].length)];
}
