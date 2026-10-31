// The Playwright test every browser spec uses: the same as "playwright/test",
// except every browser context it creates (including ones a test makes itself)
// serves published schema files from the disk cache. See support/supabase_cache.cjs.
const base = require("playwright/test");
const { installSupabaseCache } = require("./support/supabase_cache.cjs");

const test = base.test.extend({
  browser: [async ({ browser }, use) => {
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (...args) => {
      const context = await newContext(...args);
      await installSupabaseCache(context);
      return context;
    };
    await use(browser);
    browser.newContext = newContext;
  }, { scope: "worker" }],
});

module.exports = { test, expect: base.expect };
