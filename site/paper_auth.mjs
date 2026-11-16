import { createOpenRouterAuthorization, exchangeOpenRouterCode } from "./openrouter_connection.mjs";
import { paperReviewAllowed } from "./paper_review_access.mjs";
const status = document.getElementById("status");
const storageKey = "echo-paper-pkce-v1";
async function connect() {
  if (!paperReviewAllowed()) throw new Error("Paper review is limited to permastaging.");
  const url = new URL(location.href), code = url.searchParams.get("code");
  if (!window.opener) throw new Error("Open this connection window from the Echo review page.");
  if (!code) {
    const nonce = new URLSearchParams(url.hash.slice(1)).get("nonce");
    if (!nonce || !/^[0-9a-f-]{36}$/.test(nonce)) throw new Error("Connection request is missing its nonce.");
    const callback = new URL("./paper-auth.html", location.href);
    const pending = await createOpenRouterAuthorization(callback.href);
    sessionStorage.setItem(storageKey, JSON.stringify({ verifier: pending.verifier, state: pending.state, nonce, createdAt: Date.now() }));
    location.replace(pending.url);
    return;
  }
  const state = url.searchParams.get("state");
  history.replaceState(null, "", url.pathname);
  const pending = JSON.parse(sessionStorage.getItem(storageKey) || "null");
  sessionStorage.removeItem(storageKey);
  if (!pending || state !== pending.state || Date.now() - pending.createdAt > 15 * 60 * 1000) throw new Error("Authorization could not be verified. Connect again.");
  const key = await exchangeOpenRouterCode(code, pending.verifier);
  // Same Echo origin and exact opener. The review page may remember the capped key through its authenticated extension bridge.
  window.opener.postMessage({ type: "echo-paper-connected-v1", nonce: pending.nonce, key }, location.origin);
  status.textContent = "Connected. You can close this window.";
  window.close();
}
connect().catch(() => { status.textContent = "Connection did not complete. Return to Echo and connect again. No key has been saved."; });
