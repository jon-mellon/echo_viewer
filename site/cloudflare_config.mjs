// Public settings for the Cloudflare publishing service (see docs/publishing-api.md). Both are public values.
// The registry and publishing use Cloudflare for every page.
export const CLOUDFLARE_API_URL = "https://echo-api.epistemicinfra.org";
export const TURNSTILE_SITE_KEY = "0x4AAAAAAFvLr4WtZWarWgmI";

export const cloudflareApiConfigured = (apiUrl = CLOUDFLARE_API_URL) => Boolean(apiUrl);
