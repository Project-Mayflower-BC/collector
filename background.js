import { listSessions, saveBatch } from "./db.js";
import { isColonistUrl, safeUrl } from "./scope.js";

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== "capture-batch") return;
  if (!sender.tab || sender.frameId !== 0 || !isColonistUrl(sender.url, ["https:"])) {
    respond({ ok: false, error: "Capture is restricted to Colonist tabs." });
    return;
  }
  if (typeof message.documentId !== "string" || !/^[a-f0-9-]{36}$/i.test(message.documentId) ||
      !Array.isArray(message.events) || message.events.length > 50) {
    respond({ ok: false, error: "Invalid capture batch." });
    return;
  }
  const events = message.events.filter(event => Number.isSafeInteger(event.sequence) &&
    event.sequence > 0 && typeof event.timestamp === "string" &&
    (event.transport === "collector" || isColonistUrl(event.url)));
  void saveBatch({ id: message.documentId, tabId: sender.tab.id,
    pageUrl: safeUrl(sender.url), startedAt: message.startedAt,
    bridgeDropped: message.dropped || 0 }, events).then(
      () => respond({ ok: true }), error => respond({ ok: false, error: String(error) }));
  return true;
});

async function badge() {
  const { recordingEnabled } = await chrome.storage.local.get({ recordingEnabled: true });
  await chrome.action.setBadgeText({ text: recordingEnabled ? "REC" : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: recordingEnabled ? "#06746d" : "#657080" });
}
chrome.runtime.onInstalled.addListener(() => { void badge(); });
chrome.runtime.onStartup.addListener(() => { void badge(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.recordingEnabled) void badge();
});
// Storage is in IndexedDB, independent of the service worker's lifetime.
export { listSessions };
