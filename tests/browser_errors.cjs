const { expect } = require("playwright/test");

/**
 * A snapshot whose viewer assets are not published answers the viewer's probe for them with a 404, which the browser logs
 * as a console error although the viewer handles it (and warns about the missing assets itself). Only that URL is excused.
 */
function isViewerAssetsProbe404(message) {
  return /status of 404/.test(message.text()) && /\/viewer-assets\/manifest\.json$/.test(message.location?.().url || "");
}

function watchBrowserErrors(page, { warnings = false } = {}) {
  const errors = [];
  const statusesByUrl = new Map();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" || (warnings && message.type() === "warning")) {
      if (isViewerAssetsProbe404(message)) return;
      errors.push(message.text());
    }
  });
  page.on("response", response => {
    const statuses = statusesByUrl.get(response.url()) || [];
    statuses.push(response.status());
    statusesByUrl.set(response.url(), statuses);
  });

  const check = () => {
    const rateLimited = [...statusesByUrl].filter(([, statuses]) => statuses.includes(429));
    const unrecovered = rateLimited.filter(([, statuses]) =>
      !statuses.slice(statuses.lastIndexOf(429) + 1).some(status => status >= 200 && status < 300));
    expect(unrecovered, "HTTP 429 responses must be retried successfully").toEqual([]);
    const recovered429Count = rateLimited.reduce((count, [, statuses]) =>
      count + statuses.filter(status => status === 429).length, 0);
    const transient429 = /^Failed to load resource: the server responded with a status of 429 \(\)$/i;
    expect(errors.filter(error => transient429.test(error)).length).toBeLessThanOrEqual(recovered429Count);
    expect(errors.filter(error => !/favicon|Range request .* did not return a partial response/i.test(error)
      && !transient429.test(error))).toEqual([]);
  };
  return { errors, check };
}

module.exports = { watchBrowserErrors, isViewerAssetsProbe404 };
