import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { confirmPublicPublication } from "../site/publication_consent.mjs";

const source = await readFile(new URL("../site/dag_publication.mjs", import.meta.url), "utf8");
const core = await readFile(new URL("../site/dag_publication_core.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");

test("share warns when the schema is unpublished and offers to publish first", () => {
  assert.match(source, /hasLocalChanges = !await matchesPublished\(published\)/);
  assert.match(source, /confirmPublishBeforeShare\(neverPublished\)/);
  assert.match(source, /published = await publish\(\);/);
  assert.match(source, /if \(!await confirmPublishBeforeShare\(neverPublished\)\) return null;/);
  assert.doesNotMatch(source, /Copied a view permalink using the last published schema/);
  assert.match(source, /publicationPermalink\(published\.publication_id/);
  assert.match(source, /getPermalinkState\(\)/);
});

test("share rebuilds a published permalink from the current view state", () => {
  const stablePermalink = source.slice(
    source.indexOf("function stablePermalink"),
    source.indexOf("function renderPublicationState"),
  );
  assert.match(stablePermalink, /publicationPermalink\(published\.publication_id, windowApi\.location, getPermalinkState\(\)\)/);
  assert.ok(stablePermalink.indexOf("published?.publication_id") < stablePermalink.indexOf("published?.permalink"));
});

test("successful sharing gives visible feedback on the share button", () => {
  assert.match(source, /button\.setAttribute\("aria-label", "Copied"\)/);
  assert.match(source, /button\.classList\.add\("share-copied"\)/);
  assert.match(source, /button\.setAttribute\("aria-label", "Share view"\)/);
  assert.match(source, /showShareCopied\(\)/);
});

test("publication explicitly confirms public immutable access", () => {
  assert.match(html, /Publish this schema publicly\?/);
  assert.match(html, /immutable public version/);
  assert.match(html, /New publications are unlisted and do not appear in public split discovery/);
  assert.match(source, /confirmPublicPublication\(elements\.confirmation, windowApi\)/);
});

test("publication requests authentication only after immutable-public confirmation", () => {
  const publish = source.slice(source.indexOf("async function publish()"), source.indexOf("async function share()"));
  assert.ok(publish.indexOf("confirmPublicPublication(elements.confirmation, windowApi)") < publish.indexOf("publishSchema({"));
  assert.match(core, /ensureOwner\(cloudflare\)/);
});

test("publication requires a fresh CC0 agreement for every attempt", async () => {
  assert.match(html, /creativecommons\.org\/publicdomain\/zero\/1\.0\//);
  assert.match(html, /without permission or attribution/);
  assert.match(html, /no third-party copyrighted material or unsuitable content/);

  const consent = Object.assign(new EventTarget(), { checked: true });
  const publishButton = { disabled: false };
  const dialog = Object.assign(new EventTarget(), {
    returnValue: "publish",
    querySelector(selector) {
      return selector === "[data-publication-consent]" ? consent : publishButton;
    },
    showModal() {},
  });

  const first = confirmPublicPublication(dialog, {});
  assert.equal(consent.checked, false);
  assert.equal(publishButton.disabled, true);
  dialog.returnValue = "publish";
  dialog.dispatchEvent(new Event("close"));
  assert.equal(await first, false);

  const second = confirmPublicPublication(dialog, {});
  consent.checked = true;
  consent.dispatchEvent(new Event("change"));
  assert.equal(publishButton.disabled, false);
  dialog.returnValue = "publish";
  dialog.dispatchEvent(new Event("close"));
  assert.equal(await second, true);

  const third = confirmPublicPublication(dialog, {});
  assert.equal(consent.checked, false);
  assert.equal(publishButton.disabled, true);
  dialog.returnValue = "cancel";
  dialog.dispatchEvent(new Event("close"));
  assert.equal(await third, false);
});

test("publication fallback includes the CC0 agreement", async () => {
  let message = "";
  const accepted = await confirmPublicPublication(null, {
    confirm(text) { message = text; return true; },
  });
  assert.equal(accepted, true);
  assert.match(message, /CC0 1\.0 Universal/);
  assert.match(message, /without an attribution requirement/);
  assert.match(message, /no third-party copyrighted material or unsuitable content/);
});

test("published state distinguishes private working-copy changes", () => {
  assert.match(source, /label: "Unpublished changes"/);
  assert.match(source, /label: "Local draft"/);
  assert.match(source, /label: "Published"/);
  assert.match(source, /setBadge\(publicationStatus\(published, hasLocalChanges\)\)/);
  assert.match(source, /workingCopyChanged/);
  assert.match(source, /hasPublishableChanges = !published\?\.publication_id \|\| hasLocalChanges/);
  assert.match(source, /elements\.publish\.hidden = !hasPublishableChanges/);
});

test("completed schema hydration clears the loading status instead of logging success", () => {
  const ready = source.slice(source.indexOf("function setSchemaReady"), source.indexOf("function setSchemaLoadFailed"));
  assert.match(ready, /Loading group memberships…/);
  assert.match(ready, /else clearStatus\(\)/);
  assert.doesNotMatch(source, /Loaded the public schema/);
});
