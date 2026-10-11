import test from "node:test";
import assert from "node:assert/strict";
import { Recorder } from "../recorder.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness({ prior, notice = null, own = true, url = "https://colonist.io/", loaderId = "document-1",
  checkpointError = null, savedMetadata = {}, enabled = true, frameUrl = url, enableError = null } = {}) {
  const calls = [], events = new Map(), timers = new Set();
  const local = { recordingEnabled: enabled, recorderNotice: notice };
  const session = { debuggerRecording: prior };
  const api = {
    storage: {
      local: { get: async defaults => ({ ...defaults, ...local }), set: async fields => Object.assign(local, structuredClone(fields)) },
      session: { get: async () => ({ ...session }), set: async fields => Object.assign(session, structuredClone(fields)), remove: async key => { delete session[key]; } }
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
      if (checkpointError) throw checkpointError;
      return { sequence: 40, session: { ...prior, captureDropped: 3, ...savedMetadata },
        sockets: [["123.4", { url: "wss://socket.svr.colonist.io/", connectionId: "ws-123.4" }]] };
    },
    interval: callback => { timers.add(callback); return callback; },
    cancelInterval: callback => timers.delete(callback)
  });
  return { recorder, api, calls, local, session, events, timers, metadata: () => metadata,
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
  h.recorder.detached({ tabId: 7 }, "canceled_by_user");
  await tick();
  assert.equal(h.api.badge, "ERR");
  assert.equal(h.timers.size, 0);
  assert.equal(h.local.recorderNotice.detachReason, "canceled_by_user");
  assert.ok(h.local.recorderNotice.at);
  assert.equal(h.metadata().interrupted, true);
  assert.equal(h.metadata().detachReason, "canceled_by_user");
  const fresh = harness({ notice: h.local.recorderNotice });
  await fresh.recorder.ready;
  assert.match(fresh.recorder.status().notice, /canceled_by_user/);
  assert.equal(fresh.api.badge, "ERR");
  await fresh.recorder.request({ type: "recorder-start", tabId: 7 });
  await fresh.recorder.request({ type: "recorder-stop" });
  assert.equal(fresh.timers.size, 0);
  assert.equal(fresh.api.badge, "OFF");
  assert.equal(fresh.metadata().stopCode, "user_stop");
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
