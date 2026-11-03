import { createClient } from "./vendor/supabase.mjs";
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./supabase_config.mjs";

export function hasSupabaseConfig() {
  return Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
}

let client = null;
const realClient = () => client ??= createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    detectSessionInUrl: false,
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Created on first use, not on import: creating it restores any stored session and starts the token refresh timer,
// which would call Supabase on pages that read everything from Cloudflare.
export const supabase = hasSupabaseConfig()
  ? new Proxy({}, {
      get(_target, property) {
        const real = realClient(), value = real[property];
        return typeof value === "function" ? value.bind(real) : value;
      },
    })
  : null;
