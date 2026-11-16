import { createKeyStore } from "./key_store.mjs";
import { REVIEW_URL } from "./config.mjs";
const origin = new URL(REVIEW_URL).origin;
const nonce = crypto.randomUUID();
const url = `${REVIEW_URL}#bridge=${nonce}`;
const frame = document.getElementById("echo"), status = document.getElementById("status");
frame.src = url;
let paper = null, popup = null;
const ready = new Set();
const keys = createKeyStore(chrome.storage);
function send(target) { if (paper && ready.has(target)) target.postMessage({ type: "echo-paper-capture-v1", nonce, capture: paper }, origin); }
window.addEventListener("message", async event => {
  if (event.origin !== origin || ![frame.contentWindow, popup].includes(event.source) || !event.source
    || event.data?.nonce !== nonce) return;
  const reply = payload => event.source.postMessage({ ...payload, nonce }, origin);
  if (event.data.type === "echo-paper-ready-v1") {
    ready.add(event.source);
    try { reply({ type: "echo-paper-connection-v1", ...(await keys.read()) }); }
    catch { reply({ type: "echo-paper-storage-error-v1", message: "Connection storage is unavailable. Reconnect for this window." }); }
    send(event.source);
    status.textContent = paper ? "Paper sent to Echo. Choose a claim after extraction." : "Echo is ready. Reading the current paper…";
  } else if (ready.has(event.source) && ["echo-paper-save-key-v1", "echo-paper-forget-key-v1"].includes(event.data.type)) {
    try {
      if (event.data.type === "echo-paper-save-key-v1") await keys.save(event.data.key, event.data.persistent === true);
      else await keys.forget();
      reply({ type: "echo-paper-key-saved-v1", requestId: event.data.requestId, forgotten: event.data.type === "echo-paper-forget-key-v1", persistent: event.data.persistent === true });
    } catch { reply({ type: "echo-paper-storage-error-v1", requestId: event.data.requestId, message: "The browser could not save this connection." }); }
  }
});
let windowId;
function receive(result) {
  if (result.error) {
    status.textContent = /permission|cannot access|not allowed|host permission/i.test(result.error)
      ? "Click the Echo extension icon in Chrome's toolbar on the article to allow automatic capture. Opening the side-panel picker does not grant page access."
      : `Capture failed: ${result.error}`;
    return;
  }
  paper = result.paper;
  send(frame.contentWindow); if (popup && !popup.closed) send(popup);
  status.textContent = "Paper captured automatically. Echo will extract the claims automatically once connected.";
}
async function captureCurrent(refresh = false) {
  status.textContent = "Reading the current paper…";
  try {
    windowId = (await chrome.windows.getCurrent()).id;
    receive(await chrome.runtime.sendMessage({ type: "echo-capture-current", windowId, refresh }));
  } catch (error) { receive({ error: error.message }); }
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type === "echo-capture-result" && message.windowId === windowId) receive(message);
});
document.getElementById("capture").addEventListener("click", () => captureCurrent(true));
void captureCurrent();
document.getElementById("open").addEventListener("click", () => { popup = window.open(url, "_blank"); });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes["echo-openrouter-key-v1"] && !changes["echo-openrouter-key-v1"].newValue) {
    for (const target of ready) target.postMessage({ type: "echo-paper-forgotten-v1", nonce }, origin);
  }
});
