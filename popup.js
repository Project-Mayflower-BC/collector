import { listSessions } from "./db.js";
import { isColonistUrl } from "./scope.js";
const $ = selector => document.querySelector(selector);
let selectedTabId;
const toggle = $("#enabled");
toggle.checked = (await chrome.storage.local.get({ recordingEnabled: true })).recordingEnabled;
toggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ recordingEnabled: toggle.checked });
  await refresh();
});
$("#open").addEventListener("click", () => { void chrome.tabs.create({ url: chrome.runtime.getURL("viewer.html") }); });
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || "Recorder did not respond.");
  return result;
}
for (const [id, type] of [["#start", "recorder-start"], ["#stop", "recorder-stop"]]) {
  $(id).addEventListener("click", async () => {
    $("#start").disabled = $("#stop").disabled = true;
    try { await request({ type, tabId: selectedTabId }); await refresh(); }
    catch (error) { $("#status").textContent = String(error); }
  });
}
async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    selectedTabId = tab?.id;
    const [recorder, targets, sessions] = await Promise.all([
      request({ type: "recorder-status" }), chrome.debugger.getTargets(), listSessions()
    ]);
    const target = targets.find(item => item.tabId === selectedTabId && item.type === "page");
    const attached = recorder.activeTabId !== null;
    $("#start").disabled = attached || recorder.busy || recorder.queued > 0 || recorder.pendingBodies > 0 || !isColonistUrl(target?.url, ["https:"]);
    $("#stop").disabled = !attached || recorder.busy;
    toggle.checked = recorder.enabled;
    const saved = sessions.find(session => session.id === recorder.sessionId)?.eventCount || 0;
    $("#status").textContent = (attached ? `${recorder.enabled ? "Recording" : "Paused"}${recorder.activeTabId === selectedTabId ? " this tab" : " another Colonist tab"} · ${saved} saved` : recorder.interrupted ? "Recording interrupted" : `${sessions.length} saved recording(s)`) +
      ` · ${recorder.queued + recorder.pendingBodies} waiting` + (recorder.dropped ? ` · ${recorder.dropped} dropped` : "") +
      (recorder.lastError ? ` · Storage error: ${recorder.lastError}` : "");
    $("#activity").textContent = recorder.lastMessageAt ? `Last payload: ${new Date(recorder.lastMessageAt).toLocaleTimeString()}` : "No payload received in this recording yet.";
    $("#notice").hidden = !recorder.notice;
    $("#notice").textContent = recorder.notice ? `${recorder.noticeAt ? new Date(recorder.noticeAt).toLocaleTimeString() + " · " : ""}${recorder.notice}` : "";
  } catch (error) { $("#status").textContent = String(error); }
}
await refresh();
setInterval(() => { void refresh(); }, 1500);
