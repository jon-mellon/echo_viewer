import { createClient } from "/vendor/supabase.mjs";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "/supabase_config.mjs";

export const AUTH_MESSAGE_TYPE = "dag-supabase-auth-result";
export const APP_ORIGIN = "http://127.0.0.1:8767";
export const AUTH_CALLBACK_URL = `${APP_ORIGIN}/auth-callback.html`;

export function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

export const supabase = hasSupabaseConfig()
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: {
        flowType: "pkce",
        detectSessionInUrl: true,
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : null;

