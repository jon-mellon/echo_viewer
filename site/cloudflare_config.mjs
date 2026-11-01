// Public settings for the Cloudflare publishing worker (cloudflare/publish-worker). Both are public values.
// Until they are filled in, `?schema_source=cloudflare` still reads files from R2 but keeps using Supabase for the
// registry, and publishing from a Cloudflare page is refused rather than quietly writing to Supabase.
export const CLOUDFLARE_API_URL = "";   // e.g. "https://echo-api.epistemicinfra.org"
export const TURNSTILE_SITE_KEY = "";   // the Turnstile widget's public site key

export const cloudflareApiConfigured = (apiUrl = CLOUDFLARE_API_URL) => Boolean(apiUrl);
