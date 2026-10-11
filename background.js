import { saveBatch, readSession } from "./db.js";
import { isColonistUrl, safeUrl } from "./scope.js";
import { EventWriter } from "./writer.js";
import { NetworkCapture, PAYLOAD_LIMIT } from "./network.js";

let active = null;
let lastWriter = null;
let busy = false;
let enabled = true;
let lastNotice = "";
let recoveryError = null;
let ledgerWrites = Promise.resolve();
function ledger(operation) {
  const result = ledgerWrites.then(operation);
  ledgerWrites = result.catch(() => {});
  return result;
}
const pending = writer => writer && (writer.status().queued || writer.pendingBodies || writer.running || writer.dirty);
async function badge() {
  await chrome.action.setBadgeText({ text: active ? (enabled ? "REC" : "PAUSE") : "OFF" });
  await chrome.action.setBadgeBackgroundColor({ color: active && enabled ? "#06746d" : "#657080" });
}
async function clearLedger() {
  await ledger(async () => {
    if (!active && !pending(lastWriter)) await chrome.storage.session.remove("debuggerRecording");
  });
}
const ready = (async () => {
  enabled = (await chrome.storage.local.get({ recordingEnabled: true })).recordingEnabled;
  const { debuggerRecording: interrupted } = await chrome.storage.session.get("debuggerRecording");
  if (interrupted) {
    try { await chrome.debugger.detach({ tabId: interrupted.tabId }); } catch { /* Target may already be gone. */ }
    try {
      let previous;
      try { previous = await readSession(interrupted.id); }
      catch (error) { if (error.message !== "Recording not found.") throw error; }
      const sequence = (previous?.events || []).reduce((max, event) => Math.max(max, event.sequence), 0) + 1;
      await saveBatch({ ...previous?.session, ...interrupted,
        captureDropped: previous?.session.captureDropped || 0, endedAt: new Date().toISOString() }, [{ sequence,
        timestamp: new Date().toISOString(), transport: "collector", kind: "gap",
        detail: "Recorder restarted; uncommitted events may be missing. Start a new recording." }]);
      await chrome.storage.session.remove("debuggerRecording");
      lastNotice = "Previous recording interrupted. Start again before joining a game.";
    } catch (error) { recoveryError = lastNotice = `Could not mark interrupted recording: ${String(error)}`; }
  }
  await badge();
})();
async function start(tabId) {
  if (recoveryError) throw new Error(recoveryError);
  if (active || pending(lastWriter)) throw new Error("Stop the current recording and wait for pending writes before starting another.");
  const target = (await chrome.debugger.getTargets()).find(item => item.tabId === tabId && item.type === "page");
  if (!target || !isColonistUrl(target.url, ["https:"])) throw new Error("Select an HTTPS Colonist tab first.");
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  let capture;
  try {
    await chrome.debugger.sendCommand(debuggee, "Page.enable");
    const { frameTree } = await chrome.debugger.sendCommand(debuggee, "Page.getFrameTree");
    if (!isColonistUrl(frameTree.frame.url, ["https:"])) throw new Error("Tab left Colonist before recording started.");
    const metadata = { id: crypto.randomUUID(), tabId, pageUrl: safeUrl(frameTree.frame.url),
      startedAt: new Date().toISOString(), captureMode: "chrome-debugger", captureDropped: 0 };
    const writer = new EventWriter(metadata, saveBatch, { changed: () => { void clearLedger().catch(() => {}); } });
    capture = new NetworkCapture(writer, (method, params) => chrome.debugger.sendCommand(debuggee, method, params),
      reason => { void stop(reason).catch(error => { lastNotice = String(error); }); }, enabled);
    capture.mainFrameId = frameTree.frame.id;
    active = { tabId, capture, writer };
    lastWriter = writer;
    await ledger(() => chrome.storage.session.set({ debuggerRecording: metadata }));
    capture.diagnostic("start", "Attached using Chrome Network events. Earlier traffic is unavailable; refresh before joining a game.");
    await chrome.debugger.sendCommand(debuggee, "Network.enable", {
      maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: PAYLOAD_LIMIT, maxPostDataSize: 0
    });
    if (active?.capture !== capture) throw new Error("Recording interrupted during attachment.");
    lastNotice = "";
    await badge();
  } catch (error) {
    if (active?.capture === capture) { active.capture.close(`Attach failed: ${String(error)}`); active = null; }
    try { await chrome.debugger.detach(debuggee); } catch { /* Failed attachment/closed tab. */ }
    await clearLedger();
    await badge();
    throw error;
  }
}
async function stop(reason = "Stopped by user.", detached = false) {
  const previous = active;
  if (!previous) return;
  active = null;
  if (detached) previous.capture.diagnostic("gap", reason);
  previous.capture.close(reason);
  lastNotice = reason;
  if (!detached) {
    try { await chrome.debugger.detach({ tabId: previous.tabId }); }
    catch (error) { lastNotice += ` Detach reported: ${String(error)}`; }
  }
  await clearLedger();
  await badge();
}
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId || !active || source.tabId !== active.tabId) return;
  const capture = active.capture;
  void capture.handle(method, params).catch(error => capture.diagnostic("gap", `Event processing failed: ${String(error)}`));
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === active?.tabId) {
    void stop(`Debugger detached: ${reason}. Recording interrupted.`, true)
      .catch(error => { lastNotice = `Detach cleanup failed: ${String(error)}`; });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.recordingEnabled) return;
  enabled = changes.recordingEnabled.newValue !== false;
  active?.capture.setEnabled(enabled);
  void badge();
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
  if (!["recorder-status", "recorder-start", "recorder-stop"].includes(message?.type)) return;
  void (async () => {
    await ready;
    if (message.type !== "recorder-status") {
      if (busy) throw new Error("Recorder operation is already in progress.");
      busy = true;
      try {
        if (message.type === "recorder-start") {
          if (!Number.isInteger(message.tabId)) throw new Error("Invalid tab.");
          await start(message.tabId);
        } else await stop();
      } finally { busy = false; }
    }
    return { ok: true, activeTabId: active?.tabId ?? null, enabled, busy, notice: lastNotice,
      ...(lastWriter?.status() || { queued: 0, pendingBodies: 0, dropped: 0 }) };
  })().then(respond, error => respond({ ok: false, error: String(error) }));
  return true;
});
