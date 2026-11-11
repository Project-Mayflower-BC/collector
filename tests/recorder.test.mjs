import test from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../recorder.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
const settled = async () => { for (let i = 0; i < 20; i++) await tick(); };
function harness({ prior, notice = null, own = true, url = "https://colonist.io/", loaderId = "document-1",
  checkpointError = null, savedMetadata = {}, enabled = true, frameUrl = url, enableError = null,
  downloadState = "complete", checkpointGate = null } = {}) {
  const calls = [], events = new Map(), timers = new Set(), downloads = [], removed = [], released = [];
  const downloadListeners = new Set();
  const local = { recordingEnabled: enabled, recorderNotice: notice };
  const session = { debuggerRecording: prior };
  const api = {
    storage: {
      local: { get: async defaults => ({ ...defaults, ...local }), set: async fields => Object.assign(local, structuredClone(fields)) },
      session: { get: async () => ({ ...session }), set: async fields => Object.assign(session, structuredClone(fields)), remove: async key => { delete session[key]; } }
    },
    tabs: { get: async tabId => ({ id: tabId, windowId: 1 }) },
    downloads: {
      download: async options => { downloads.push(options); return downloads.length; },
      search: async () => [{ state: downloadState, error: downloadState === "interrupted" ? "FILE_FAILED" : undefined }],
      onChanged: { addListener: listener => downloadListeners.add(listener), removeListener: listener => downloadListeners.delete(listener) }
    },
    action: { setBadgeText: async fields => { api.badge = fields.text; }, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    debugger: {
      getTargets: async () => [{ type: "page", tabId: 7, url }],
      attach: async () => { calls.push("attach"); own = true; },
      detach: async () => { calls.push("detach"); own = false; },
      sendCommand: async (_source, method) => {
        calls.push(method);
        if (!own) throw new Error("Debugger is not attached to this tab.");
        if (method === "Network.enable" && enableError) throw enableError;
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main", url: frameUrl, loaderId } } };
        return {};
      }
    }
  };
  let metadata;
  const recorder = new Recorder(api, {
    save: async (meta, batch) => { metadata = structuredClone(meta); for (const event of batch) events.set(event.sequence, event); },
    checkpoint: async () => {
      if (checkpointGate) await checkpointGate;
      if (checkpointError) throw checkpointError;
      return { sequence: 40, session: { ...prior, captureDropped: 3, ...savedMetadata },
        sockets: [["123.4", { url: "wss://socket.svr.colonist.io/", connectionId: "ws-123.4" }]] };
    },
    prepare: async id => ({ url: `blob:${id}`, filename: `colonist-${id}.json`, release: async () => { released.push(id); } }),
    remove: async id => { removed.push(id); },
    wait: () => new Promise(resolve => setImmediate(resolve)),
    interval: callback => { timers.add(callback); return callback; },
    cancelInterval: callback => timers.delete(callback)
  });
  return { recorder, api, calls, local, session, events, timers, downloads, removed, released, metadata: () => metadata,
    loseConnection: () => { own = false; } };
}
const prior = { id: "prior", tabId: 7, startedAt: "2026-10-11T00:00:00Z", pageUrl: "https://colonist.io/",
  documentLoaderId: "document-1", captureMode: "chrome-debugger" };
test("background restart restores an owned attachment and its existing socket without detaching", async () => {
  const h = harness({ prior });
  await h.recorder.ready;
  assert.equal(h.recorder.status().activeTabId, 7);
  assert.ok(!h.calls.includes("detach") && !h.calls.includes("attach"));
  assert.ok(h.calls.includes("Network.enable"), "Network capture is re-enabled even if the initial worker died during startup");
  h.recorder.handle({ tabId: 7 }, "Network.webSocketFrameReceived", { requestId: "123.4", response: { opcode: 1, payloadData: "after-restart" } });
  await tick();
  assert.equal(h.events.get(41).kind, "gap");
  assert.equal(h.events.get(42).payload.data, "after-restart");
  assert.equal(h.metadata().captureDropped, 3);
  assert.equal(h.timers.size, 1);
  await h.recorder.stop();
});
test("restart never attaches to another debugger's target or restores sockets from a changed document", async () => {
  const lost = harness({ prior, own: false });
  await lost.recorder.ready;
  await tick();
  assert.equal(lost.recorder.status().activeTabId, null);
  assert.equal(lost.api.badge, "ERR");
  assert.equal(lost.metadata().stopCode, "worker_session_lost");
  assert.ok(!lost.calls.includes("attach"));
  assert.equal(lost.local.recorderNotice.unexpected, true);
  const changed = harness({ prior, loaderId: "document-2" });
  await changed.recorder.ready;
  assert.equal(changed.recorder.active.capture.sockets.size, 0);
  await tick();
  assert.match(changed.events.get(41).detail, /page changed/);
  await changed.recorder.stop();
});
test("out-of-scope recovery is stopped even when a previously allowed target navigates during the probe", async () => {
  const h = harness({ prior, frameUrl: "https://example.test/" });
  await h.recorder.ready;
  assert.equal(h.recorder.active, null);
  assert.ok(!h.calls.includes("attach"));
  assert.equal(h.api.badge, "ERR");
});
test("detach reason/time persist after the popup and worker close; explicit stop clears the health timer", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  assert.equal(h.timers.size, 1);
  h.recorder.detached({ tabId: 7 }, "target_closed");
  await tick();
  assert.equal(h.api.badge, "ERR");
  assert.equal(h.timers.size, 0);
  assert.equal(h.local.recorderNotice.detachReason, "target_closed");
  assert.ok(h.local.recorderNotice.at);
  await settled();
  assert.match(h.local.recorderNotice.message, /Saved colonist-.*\.json to Downloads/);
  assert.equal(h.metadata().interrupted, true);
  assert.equal(h.metadata().detachReason, "target_closed");
  const fresh = harness({ notice: h.local.recorderNotice });
  await fresh.recorder.ready;
  assert.match(fresh.recorder.status().notice, /target_closed/);
  assert.equal(fresh.api.badge, "ERR");
  await fresh.recorder.request({ type: "recorder-start", tabId: 7 });
  await fresh.recorder.request({ type: "recorder-stop" });
  assert.equal(fresh.timers.size, 0);
  assert.equal(fresh.api.badge, "OFF");
  assert.equal(fresh.metadata().stopCode, "user_stop");
});
test("cancelling Chrome's debugging banner is a clean stop that keeps captured events", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  h.recorder.handle({ tabId: 7 }, "Network.webSocketCreated", { requestId: "9", url: "wss://socket.svr.colonist.io/" });
  await tick();
  h.recorder.detached({ tabId: 7 }, "canceled_by_user");
  await tick();
  assert.equal(h.recorder.status().activeTabId, null);
  assert.equal(h.api.badge, "OFF");
  assert.equal(h.timers.size, 0);
  assert.ok(!h.calls.includes("detach"));
  assert.equal(h.metadata().interrupted, false);
  assert.equal(h.metadata().stopCode, "banner_cancel");
  assert.equal(h.metadata().detachReason, "canceled_by_user");
  assert.ok([...h.events.values()].some(event => event.kind === "connect"));
  assert.equal([...h.events.values()].at(-1).kind, "stop");
  assert.equal(h.local.recorderNotice.unexpected, false);
});
test("health check catches a lost connection even without an onDetach event", async () => {
  const h = harness();
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  await h.recorder.checkHealth();
  assert.ok(h.recorder.status().lastHealthAt);
  h.loseConnection();
  await h.recorder.checkHealth();
  await tick();
  assert.equal(h.recorder.status().activeTabId, null);
  assert.equal(h.api.badge, "ERR");
  assert.equal(h.metadata().stopCode, "connection_lost");
});
test("storage read failure blocks recovery rather than overwriting saved event sequences", async () => {
  const h = harness({ prior, checkpointError: new Error("disk read failed") });
  await h.recorder.ready;
  assert.match(h.recorder.status().notice, /disk read failed/);
  assert.equal(h.events.size, 0);
  await assert.rejects(h.recorder.request({ type: "recorder-start", tabId: 7 }), /disk read failed/);
});
test("failed Network recovery ends the session rather than displaying a false REC badge", async () => {
  const h = harness({ prior, enableError: new Error("Network unavailable") });
  await h.recorder.ready;
  await tick();
  assert.equal(h.recorder.active, null);
  assert.equal(h.api.badge, "ERR");
  assert.equal(h.metadata().stopCode, "worker_recovery_failed");
  assert.equal(h.timers.size, 0);
  assert.ok(!h.calls.includes("attach"));
});
test("stopping saves the recording as JSON in Downloads, then clears the local copy", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  const id = h.recorder.status().sessionId;
  await h.recorder.request({ type: "recorder-stop" });
  assert.equal(h.recorder.status().saving, true, "Stop returns before the file is written");
  await settled();
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(h.downloads[0], { url: `blob:${id}`, filename: `colonist-${id}.json`, conflictAction: "uniquify", saveAs: false });
  assert.deepEqual(h.removed, [id]);
  assert.deepEqual(h.released, [id]);
  assert.equal([...h.events.values()].at(-1).kind, "stop", "the stop marker is written before the file");
  assert.match(h.local.recorderNotice.message, /Stopped by user\. Saved colonist-.*\.json to Downloads\./);
  assert.equal(h.recorder.status().saving, false);
  assert.equal(h.session.debuggerRecording, undefined);
  assert.equal(h.api.badge, "OFF");
});
test("a failed download keeps the local recording and says so", async () => {
  const h = harness({ own: false, downloadState: "interrupted" });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  await h.recorder.request({ type: "recorder-stop" });
  await settled();
  assert.deepEqual(h.removed, []);
  assert.match(h.local.recorderNotice.message, /Could not save the JSON file.*FILE_FAILED.*still kept/);
  assert.equal(h.api.badge, "ERR");
});
test("viewer export saves and clears a stored recording, but never the one being recorded", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  const result = await h.recorder.request({ type: "recorder-export", sessionId: "old" });
  assert.equal(result.filename, "colonist-old.json");
  assert.deepEqual(h.removed, ["old"]);
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  await assert.rejects(h.recorder.request({ type: "recorder-export", sessionId: h.recorder.status().sessionId }), /Stop recording/);
  await h.recorder.request({ type: "recorder-stop" });
});
test("events that wake a stopped worker are kept, and status answers during recovery", async () => {
  let open;
  const h = harness({ prior, savedMetadata: { lastHealthAt: new Date(Date.now() - 20000).toISOString() },
    checkpointGate: new Promise(resolve => { open = resolve; }) });
  await tick();
  assert.equal(h.recorder.status().recovering, true);
  h.recorder.handle({ tabId: 7 }, "Network.webSocketFrameReceived", { requestId: "123.4", response: { opcode: 1, payloadData: "woke-the-worker" } });
  open();
  await h.recorder.ready;
  await tick();
  assert.equal(h.recorder.status().recovering, false);
  const kinds = [...h.events.values()].sort((a, b) => a.sequence - b.sequence);
  assert.equal(kinds[0].kind, "gap");
  assert.match(kinds[0].detail, /Last activity before the restart: .* \(2\d s earlier\)/);
  assert.equal(kinds[1].payload.data, "woke-the-worker");
  await h.recorder.stop();
});
test("switching tabs in the recorded window is logged; other windows are ignored", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  h.recorder.tabActivated({ tabId: 8, windowId: 2 });
  h.recorder.tabActivated({ tabId: 9, windowId: 1 });
  h.recorder.tabActivated({ tabId: 10, windowId: 1 });
  h.recorder.tabActivated({ tabId: 7, windowId: 1 });
  await tick();
  const tabs = [...h.events.values()].filter(event => event.kind === "tab").map(event => event.detail);
  assert.deepEqual(tabs, ["Switched to another tab; Colonist is in the background.", "Colonist tab is active again."]);
  await h.recorder.stop();
});
test("a connection check racing a banner cancel still records a clean banner stop", async () => {
  const h = harness({ own: false });
  await h.recorder.ready;
  await h.recorder.request({ type: "recorder-start", tabId: 7 });
  h.loseConnection();
  const probe = h.recorder.checkHealth();
  await tick();
  h.recorder.detached({ tabId: 7 }, "canceled_by_user");
  await probe;
  await settled();
  assert.equal(h.metadata().stopCode, "banner_cancel");
  assert.equal(h.metadata().interrupted, false);
  assert.equal(h.api.badge, "OFF");
});
