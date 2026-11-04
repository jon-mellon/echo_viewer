// Local browser tests do not depend on the live public split index or its CORS policy.
// Individual split tests can override this route with their own rows.
async function installPublishingApiFixture(context) {
  await context.route("https://echo-api.epistemicinfra.org/v1/splits**", route =>
    route.fulfill({ status: 200, contentType: "application/json",
      headers: { "access-control-allow-origin": "*" }, body: "[]" }));
}

module.exports = { installPublishingApiFixture };
