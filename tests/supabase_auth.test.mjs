import test from "node:test";
import assert from "node:assert/strict";

// Browser-root imports are rewritten only for this dependency-free unit check.
const source = await import("node:fs/promises").then(fs => fs.readFile(new URL("../site/dag_auth.mjs", import.meta.url), "utf8"));

test("auth module fixes callback to the requested localhost origin", () => {
  assert.match(source, /redirectTo: AUTH_CALLBACK_URL/);
  assert.match(source, /skipBrowserRedirect: true/);
  assert.match(source, /browserWindow\.open\("about:blank"/);
});

test("auth messages validate origin, popup source, and type", () => {
  assert.match(source, /event\.origin === APP_ORIGIN/);
  assert.match(source, /event\.source === popup/);
  assert.match(source, /event\.data\?\.type === AUTH_MESSAGE_TYPE/);
});
