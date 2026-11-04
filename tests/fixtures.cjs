// The Playwright test every browser spec uses: the same as "playwright/test",
// except every browser context it creates (including ones a test makes itself)
// serves immutable Cloudflare schema files from the disk cache.
const base = require("playwright/test");
const { installPublishedSchemaCache } = require("./support/published_schema_cache.cjs");
const { installPublishingApiFixture } = require("./support/publishing_api_fixture.cjs");

const test = base.test.extend({
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await installPublishedSchemaCache(context);
      await installPublishingApiFixture(context);
      return context;
    };
    await use(browser);
    browser.newContext = newContext;
  }, { scope: "worker" }],
});

module.exports = { test, expect: base.expect };
