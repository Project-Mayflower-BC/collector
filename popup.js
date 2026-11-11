import { isColonistUrl } from "./scope.js";
const $ = selector => document.querySelector(selector);
let selectedTabId;
let rendered = false;
const toggle = $("#enabled");
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
function showNotice(message, at) {
  $("#notice").hidden = !message;
  $("#notice").textContent = message ? `${at ? new Date(at).toLocaleTimeString() + " · " : ""}${message}` : "";
}
// First paint from storage alone, so the popup is usable before the worker answers.
async function quick() {
  const [{ debuggerRecording }, { recordingEnabled, recorderNotice }] = await Promise.all([
    chrome.storage.session.get("debuggerRecording"), chrome.storage.local.get({ recordingEnabled: true, recorderNotice: null })]);
  if (rendered) return;
  toggle.checked = recordingEnabled !== false;
  if (debuggerRecording && !debuggerRecording.endedAt) {
    $("#status").textContent = "Recording · connecting to recorder…";
    $("#stop").disabled = false;
  }
  showNotice(recorderNotice?.message, recorderNotice?.at);
}
async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    selectedTabId = tab?.id;
    const [recorder, targets] = await Promise.all([request({ type: "recorder-status" }), chrome.debugger.getTargets()]);
    const target = targets.find(item => item.tabId === selectedTabId && item.type === "page");
    const attached = recorder.activeTabId !== null;
    rendered = true;
    if (recorder.recovering) {
      $("#status").textContent = "Reconnecting to the recording…";
      $("#start").disabled = true;
      $("#stop").disabled = false;  // Stop waits for recovery; it is a no-op without a recording.
      return;
    }
    $("#start").disabled = attached || recorder.busy || recorder.saving || recorder.queued > 0 || recorder.pendingBodies > 0 || !isColonistUrl(target?.url, ["https:"]);
    $("#stop").disabled = !attached || recorder.busy;
    toggle.checked = recorder.enabled;
    $("#status").textContent = (attached ? `${recorder.enabled ? "Recording" : "Paused"}${recorder.activeTabId === selectedTabId ? " this tab" : " another Colonist tab"} · ${recorder.eventCount} events`
      : recorder.saving ? "Saving JSON to Downloads…" : recorder.interrupted ? "Recording interrupted" : "Not recording") +
      (recorder.queued + recorder.pendingBodies ? ` · ${recorder.queued + recorder.pendingBodies} waiting` : "") + (recorder.dropped ? ` · ${recorder.dropped} dropped` : "") +
      (recorder.lastError ? ` · Storage error: ${recorder.lastError}` : "");
    $("#activity").textContent = attached ? (recorder.lastMessageAt ? `Last payload: ${new Date(recorder.lastMessageAt).toLocaleTimeString()}` : "No payload received in this recording yet.") : "";
    $("#connection-warning").hidden = !attached || !recorder.enabled || recorder.webSocketMessageCount > 0;
    $("#connection-warning").textContent = "No game connection messages captured yet. Refresh Colonist after starting, then check for WebSocket entries in Recordings before playing.";
    const game = recorder.game;
    $("#game").textContent = attached && game ? `Game: ${game.summary}` : "";
    const warning = game?.lastWarning;
    $("#game-warning").hidden = !warning;
    $("#game-warning").textContent = warning ? `${game.warningCount > 1 ? `${game.warningCount} game warnings. Latest: ` : ""}${warning.message}` : "";
    showNotice(recorder.notice, recorder.noticeAt);
  } catch (error) { $("#status").textContent = String(error); }
}
void quick().catch(() => {});
void refresh();
setInterval(() => { void refresh(); }, 1000);
