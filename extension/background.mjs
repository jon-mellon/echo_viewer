import { capturePaper } from "./capture.mjs";

// Opening via Chrome's side-panel picker does not grant activeTab. The action
// invocation does, and captures the clicked tab before focus can move elsewhere.
const captures = new Map();
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
async function capture(tab) {
  if (!tab?.id) throw new Error("No article tab is available.");
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: capturePaper });
  if (!result?.result?.articleText) throw new Error("No readable HTML article text was found. If this is a PDF, open the publisher's HTML article.");
  return result.result;
}
function startCapture(tab) {
  const promise = capture(tab).then(paper => ({ paper }), error => ({ error: error.message }));
  captures.set(tab.windowId, { tabId: tab.id, url: tab.url, promise });
  return promise;
}
chrome.action.onClicked.addListener(tab => {
  // Must be invoked synchronously inside the action's user gesture.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
  void startCapture(tab).then(result => chrome.runtime.sendMessage({ type: "echo-capture-result", windowId: tab.windowId, ...result }).catch(() => {}));
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== "echo-capture-current") return;
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, windowId: message.windowId });
    const cached = captures.get(message.windowId);
    return cached?.tabId === tab?.id && cached.url === tab?.url && !message.refresh
      ? cached.promise : startCapture(tab);
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
