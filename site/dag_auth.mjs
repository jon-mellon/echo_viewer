import { APP_ORIGIN, AUTH_CALLBACK_URL, AUTH_MESSAGE_TYPE, hasSupabaseConfig, supabase } from "/supabase_client.mjs";

export function userLabel(user) {
  return user?.user_metadata?.full_name || user?.user_metadata?.name || user?.email || "Signed in";
}

export function isTrustedAuthMessage(event, popup) {
  return event.origin === APP_ORIGIN
    && event.source === popup
    && event.data?.type === AUTH_MESSAGE_TYPE;
}

export function createDagAuthController(elements, browserWindow = window) {
  let popup = null;

  function showStatus(message, isError = false) {
    elements.status.textContent = message;
    elements.status.classList.toggle("auth-error", isError);
  }

  async function refresh() {
    if (!supabase) {
      elements.signIn.hidden = false;
      elements.signOut.hidden = true;
      elements.identity.hidden = true;
      showStatus("Supabase auth is not configured.", true);
      return;
    }
    const { data, error } = await supabase.auth.getSession();
    const user = data.session?.user || null;
    elements.signIn.hidden = Boolean(user);
    elements.signOut.hidden = !user;
    elements.identity.hidden = !user;
    elements.identity.textContent = userLabel(user);
    showStatus(error ? error.message : "", Boolean(error));
  }

  async function signIn() {
    showStatus("");
    // Open synchronously inside the click handler so popup blockers permit it.
    popup = browserWindow.open("about:blank", "dag-google-auth", "popup,width=520,height=720");
    if (!popup) {
      showStatus("The sign-in popup was blocked. Allow popups and try again.", true);
      return;
    }
    popup.document.title = "Signing in…";
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: AUTH_CALLBACK_URL, skipBrowserRedirect: true },
    });
    if (error || !data?.url) {
      popup.close();
      popup = null;
      showStatus(error?.message || "Could not start Google sign-in.", true);
      return;
    }
    popup.location.assign(data.url);
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) showStatus(error.message, true);
    await refresh();
  }

  async function receiveMessage(event) {
    if (!isTrustedAuthMessage(event, popup)) return;
    popup = null;
    if (!event.data.ok) showStatus(event.data.error || "Google sign-in failed.", true);
    await refresh();
  }

  elements.signIn.addEventListener("click", signIn);
  elements.signOut.addEventListener("click", signOut);
  browserWindow.addEventListener("message", receiveMessage);
  // Leave the auth callback before calling another auth method; Supabase warns
  // that awaiting client methods inside onAuthStateChange can deadlock.
  if (supabase) supabase.auth.onAuthStateChange(() => setTimeout(() => void refresh(), 0));
  void refresh();
  return { refresh, signIn, signOut, receiveMessage };
}

export function initDagAuth() {
  const root = document.getElementById("dagAuth");
  if (!root) return null;
  root.hidden = false;
  const controller = createDagAuthController({
    signIn: document.getElementById("authSignIn"),
    signOut: document.getElementById("authSignOut"),
    identity: document.getElementById("authIdentity"),
    status: document.getElementById("authStatus"),
  });
  if (!hasSupabaseConfig()) document.getElementById("authSignIn").disabled = true;
  return controller;
}
