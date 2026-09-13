import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ensureAnonymousPublicationUser } from "../site/dag_anonymous_auth.mjs";

function authClient({ session = null, currentUser = null, sessionError = null, userError = null, anonymousResult } = {}) {
  const calls = { getSession: 0, getUser: 0, signInAnonymously: 0 };
  return {
    calls,
    auth: {
      async getSession() {
        calls.getSession += 1;
        return { data: { session }, error: sessionError };
      },
      async getUser() {
        calls.getUser += 1;
        return { data: { user: currentUser }, error: userError };
      },
      async signInAnonymously() {
        calls.signInAnonymously += 1;
        return anonymousResult || {
          data: { user: { id: "anonymous-id", is_anonymous: true }, session: { access_token: "token" } },
          error: null,
        };
      },
    },
  };
}

test("creates an anonymous user only when publication requests one", async () => {
  const client = authClient();
  assert.equal(client.calls.signInAnonymously, 0);
  const user = await ensureAnonymousPublicationUser(client);
  assert.equal(user.id, "anonymous-id");
  assert.equal(client.calls.signInAnonymously, 1);
});

test("reuses a valid persisted session without another anonymous sign-in", async () => {
  const user = { id: "persisted-id", is_anonymous: true };
  const client = authClient({ session: { access_token: "token", user }, currentUser: user });
  assert.equal((await ensureAnonymousPublicationUser(client)).id, user.id);
  assert.equal(client.calls.signInAnonymously, 0);
});

test("replaces an invalid stored session with a fresh anonymous session", async () => {
  const stale = { id: "stale-id" };
  const client = authClient({ session: { access_token: "stale", user: stale }, userError: new Error("invalid") });
  assert.equal((await ensureAnonymousPublicationUser(client)).id, "anonymous-id");
  assert.equal(client.calls.signInAnonymously, 1);
});

test("surfaces anonymous sign-in rate limits and cannot continue", async () => {
  const rateLimit = Object.assign(new Error("Anonymous sign-ins are rate limited"), { status: 429 });
  const client = authClient({ anonymousResult: { data: null, error: rateLimit } });
  await assert.rejects(() => ensureAnonymousPublicationUser(client), error => error === rateLimit);
});

test("production auth runtime persists sessions without OAuth callbacks or profile PII", async () => {
  const files = await Promise.all([
    "../site/dag_anonymous_auth.mjs",
    "../site/dag_publication.mjs",
    "../site/supabase_client.mjs",
    "../site/index.html",
    "../site/dag_builder.js",
  ].map(path => readFile(new URL(path, import.meta.url), "utf8")));
  const runtime = files.join("\n");
  assert.match(runtime, /persistSession: true/);
  assert.match(runtime, /autoRefreshToken: true/);
  assert.match(runtime, /detectSessionInUrl: false/);
  assert.doesNotMatch(runtime, /signInWithOAuth|auth-callback|provider:\s*["']google|user_metadata|identity_data|\.email\b/i);
  assert.doesNotMatch(runtime, /Sign in with|Sign out|authIdentity|authSignIn|authSignOut/i);
});
