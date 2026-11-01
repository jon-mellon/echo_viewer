// Public settings for the Cloudflare publishing worker (cloudflare/publish-worker). Both are public values.
// On a `?schema_source=cloudflare` page the registry and publishing go through the worker. If either value is blank,
// the registry stays on Supabase and publishing from a Cloudflare page is refused rather than quietly writing to Supabase.
export const CLOUDFLARE_API_URL = "https://echo-api.epistemicinfra.org";
export const TURNSTILE_SITE_KEY = "0x4AAAAAAFvLr4WtZWarWgmI";

export const cloudflareApiConfigured = (apiUrl = CLOUDFLARE_API_URL) => Boolean(apiUrl);
