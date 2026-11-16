import { REVIEW_URL } from "./config.mjs";
const origin = new URL(REVIEW_URL).origin;
const nonce = crypto.randomUUID();
const url = `${REVIEW_URL}#bridge=${nonce}`;
const frame = document.getElementById("echo"), status = document.getElementById("status");
frame.src = url;
let paper = null, popup = null;
const ready = new Set();
function send(target) { if (paper && ready.has(target)) target.postMessage({ type: "echo-paper-capture-v1", nonce, capture: paper }, origin); }
window.addEventListener("message", event => {
  if (event.origin !== origin || ![frame.contentWindow, popup].includes(event.source) || !event.source
    || event.data?.type !== "echo-paper-ready-v1" || event.data.nonce !== nonce) return;
  ready.add(event.source); send(event.source);
  status.textContent = paper ? "Paper sent to Echo. Connect to begin." : "Echo is ready. Reading the current paper…";
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
  status.textContent = "Paper captured automatically. Review its details in Echo, then connect to begin.";
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
