import { openRouterJson, cappedKeyStatus } from "./definition_jev_core.mjs";
export function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export async function sha256Base64Url(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
export async function checkCappedKey(key, signal, request = openRouterJson) {
  const { data } = await request("/api/v1/key", key, { signal });
  const problem = cappedKeyStatus(data);
  if (problem) throw new Error(problem);
  return data;
}
export async function createOpenRouterAuthorization(callback, label = "Echo paper review") {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  const url = new URL("https://openrouter.ai/auth");
  url.searchParams.set("callback_url", callback);
  url.searchParams.set("code_challenge", await sha256Base64Url(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("key_label", label);
  url.searchParams.set("state", state);
  return { url: url.href, verifier, state };
}
export async function exchangeOpenRouterCode(code, verifier, request = openRouterJson) {
  const body = await request("/api/v1/auth/keys", null, { method: "POST",
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }) });
  if (typeof body.key !== "string" || !body.key) throw new Error("OpenRouter did not return a key.");
  return body.key;
}
