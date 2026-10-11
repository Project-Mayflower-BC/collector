import { listSessions } from "./db.js";

const toggle = document.querySelector("#enabled");
const status = document.querySelector("#status");
const settings = await chrome.storage.local.get({ recordingEnabled: true });
toggle.checked = settings.recordingEnabled;
toggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ recordingEnabled: toggle.checked });
  await refresh();
});
document.querySelector("#open").addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") });
});

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let bridge;
    try { bridge = await chrome.tabs.sendMessage(tab.id, { type: "bridge-status" }); } catch { /* No recorder here. */ }
    if (!bridge) {
      const sessions = await listSessions();
      status.textContent = `${sessions.length} saved recording(s). Open or refresh a Colonist tab to capture.`;
    } else if (bridge.lastError) {
      status.textContent = `Storage error: ${bridge.lastError}. ${bridge.queued + (bridge.pendingPayloads || 0)} events waiting.`;
    } else {
      const sessions = await listSessions();
      const current = sessions.find(session => session.id === bridge.documentId);
      status.textContent = `${bridge.enabled ? "Recording" : "Paused"} · ${current?.eventCount || 0} saved events · ${bridge.queued + (bridge.pendingPayloads || 0)} waiting` +
        (bridge.dropped ? ` · ${bridge.dropped} dropped` : "");
    }
  } catch (error) { status.textContent = String(error); }
}
await refresh();
setInterval(() => { void refresh(); }, 1500);
