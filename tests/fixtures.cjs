// The Playwright test every browser spec uses: the same as "playwright/test",
// except every browser context it creates (including ones a test makes itself)
// serves published schema files from the disk cache (support/supabase_cache.cjs) and runs the viewer on the
// Cloudflare schema source, as staging ships it (support/default_source.cjs).
const base = require("playwright/test");
const { installSupabaseCache } = require("./support/supabase_cache.cjs");
const { installDefaultSource } = require("./support/default_source.cjs");

const test = base.test.extend({
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await installSupabaseCache(context);
      await installDefaultSource(context);
      return context;
    };
    await use(browser);
    browser.newContext = newContext;
  }, { scope: "worker" }],
});

module.exports = { test, expect: base.expect };
