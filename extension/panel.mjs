import { capturePaper } from "./capture.mjs";
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
  status.textContent = paper ? "Paper sent to Echo. Confirm the text before connecting or running a model." : "Echo is ready. Capture the paper to begin.";
});
document.getElementById("capture").addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePaper });
    if (!result?.result) throw new Error("No accessible article text.");
    paper = result.result;
    send(frame.contentWindow); if (popup && !popup.closed) send(popup);
    status.textContent = "Captured. Review the text and coverage in Echo; inaccessible PDFs and paywalls need pasted text.";
  } catch { status.textContent = "Chrome cannot capture this page. Open an HTML article, select accessible text, or paste text in Echo."; }
});
document.getElementById("open").addEventListener("click", () => { popup = window.open(url, "_blank"); });
