import { paperReviewAllowed } from "./paper_review_access.mjs";
import { h } from "./dom_builder.mjs";

if (paperReviewAllowed()) {
  await import("./paper_review_app.mjs");
} else {
  document.body.replaceChildren(h("main", {}, h("h1", { textContent: "Paper review is not available on this site." }),
    h("p", { textContent: "This preview is limited to the staging website." })));
}
