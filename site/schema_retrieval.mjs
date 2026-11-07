import { loadGroupingSchemaFolder } from "./grouping_schema_loader.mjs";
import { variableSchema, studyDecisionBundle } from "./schema_views.mjs";

/** Read definitions or decisions independently, including older publications. */
export async function loadSchemaView(baseUrl, view = "variables", fetchImpl = fetch) {
  if (!["variables", "decisions"].includes(view)) throw new Error("Choose the variables or decisions schema view.");
  const base = new URL(baseUrl, globalThis.location?.href || "http://localhost/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const response = await fetchImpl(new URL("manifest.json", base));
  if (!response.ok) throw new Error(`Could not load schema manifest: ${response.status}`);
  const manifest = await response.json();
  const path = view === "variables" ? manifest.variable_schema_file : manifest.study_decisions_file;
  if (path) {
    const url = new URL(path, base);
    if (!url.href.startsWith(base.href)) throw new Error("The schema view points outside its publication.");
    const artifact = await fetchImpl(url);
    if (!artifact.ok) throw new Error(`Could not load schema view: ${artifact.status}`);
    return artifact.json();
  }
  const complete = await loadGroupingSchemaFolder(base.href, fetchImpl);
  return view === "variables" ? variableSchema(complete) : studyDecisionBundle(complete);
}
