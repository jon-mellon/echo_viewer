module.exports = {
  testDir: "./tests",
  testMatch: ["browser_v2_workflows.spec.cjs", "dag2_define_variable.spec.cjs",
    "interaction_workflows.spec.cjs", "static_data_source.spec.cjs"],
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { browserName: "chromium", acceptDownloads: true },
  webServer: {
    command: "python3 -m http.server 8767 --directory site",
    url: "http://127.0.0.1:8767/",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
};
