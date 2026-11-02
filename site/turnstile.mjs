// Cloudflare Turnstile: asks the browser to prove it is a person, and resolves with a one-use token.
// The widget appears in a small dialog only when it needs the person to do something.
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoading = null;

function loadScript(doc) {
  if (doc.defaultView?.turnstile) return Promise.resolve();
  scriptLoading ||= new Promise((resolve, reject) => {
    const script = doc.createElement("script");
    script.setAttribute("src", SCRIPT); // a fixed Cloudflare address, never built from input
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => { scriptLoading = null; reject(new Error("Could not load the human check.")); };
    doc.head.append(script);
  });
  return scriptLoading;
}

export async function solveTurnstile(siteKey, doc = globalThis.document) {
  if (!siteKey) throw new Error("The human check is not set up.");
  await loadScript(doc);
  return new Promise((resolve, reject) => {
    const overlay = doc.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Checking that you are a person");
    overlay.style.cssText = "position:fixed;inset:auto 16px 16px auto;z-index:2000;background:#fff;padding:8px;border-radius:8px;"
      + "box-shadow:0 4px 18px rgba(0,0,0,.25)";
    doc.body.append(overlay);
    const done = (action, value) => { overlay.remove(); action(value); };
    doc.defaultView.turnstile.render(overlay, {
      sitekey: siteKey, appearance: "interaction-only",
      callback: token => done(resolve, token),
      "error-callback": () => done(reject, new Error("The human check failed. Please try again.")),
      "timeout-callback": () => done(reject, new Error("The human check timed out. Please try again.")),
    });
  });
}
