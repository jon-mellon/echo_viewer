// The browser workflow suite run against the newest uploaded data (see
// scripts/prepare_new_data_site.mjs). Not part of `npm test` or CI yet:
// failures here are expected while the specs still assume the frozen snapshot.
const base = require("./playwright.interactions.config.cjs");

module.exports = {
  ...base,
  maxFailures: 0,
  outputDir: "test-results/new-data",
  webServer: {
    ...base.webServer,
    command: "node scripts/prepare_new_data_site.mjs && python3 -m http.server 8767 --directory dist/new-data-site",
    // Never reuse a server on 8767: it would be serving the default data.
    reuseExistingServer: false,
  },
};
