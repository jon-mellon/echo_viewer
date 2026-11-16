import { paperReviewAllowed } from "./paper_review_access.mjs";
import { h } from "./dom_builder.mjs";

if (paperReviewAllowed()) {
  // A fresh loader can meet cached markup from an older deployment. Do not
  // start any model work until the page and controls belong to the same UI.
  if (document.body.dataset.reviewUi !== "request-diagnostics-v1") {
    const fresh = new URL(location.href);
    if (fresh.searchParams.get("ui") !== "request-diagnostics-v1") {
      fresh.searchParams.set("ui", "request-diagnostics-v1"); location.replace(fresh.href);
    } else {
      document.body.replaceChildren(h("main", {}, h("h1", { textContent: "The review page needs to refresh" }),
        h("p", { textContent: "Your saved reviews are safe. Refresh to load the updated page." }),
        h("button", { textContent: "Refresh page", onclick: () => { fresh.searchParams.set("refresh", String(Date.now())); location.replace(fresh.href); } })));
    }
  } else await import("./paper_review_app.mjs?v=request-diagnostics-v1");
} else {
  document.body.replaceChildren(h("main", {}, h("h1", { textContent: "Paper review is not available on this site." }),
    h("p", { textContent: "This preview is limited to the permastaging website." })));
}
