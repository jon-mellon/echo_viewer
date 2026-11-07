import test from "node:test";
import assert from "node:assert/strict";
import { hasUnsavedWork } from "../site/persistent_viewer.mjs";

test("an untouched definition draft does not block leaving", () => {
  assert.equal(hasUnsavedWork({ definitionDraft: { source_group_ids: [] } }), false);
  assert.equal(hasUnsavedWork({ definitionDraft: null }), false);
});

test("a started definition, a dirty schema editor and a failed schema save each block leaving", () => {
  assert.equal(hasUnsavedWork({ definitionDraft: { new_label: "Trust" } }), true);
  assert.equal(hasUnsavedWork({ definitionDraft: null, editorDirty: true }), true);
  assert.equal(hasUnsavedWork({ definitionDraft: null, unsavedSchema: true }), true);
});
