import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const source = await readFile(new URL("../bridge.js", import.meta.url), "utf8");
const settle = () => new Promise(resolve => setImmediate(resolve));

async function harness() {
  const windowListeners = new Map();
  const messages = [];
  let statusListener, tick, now = 0;
  const window = { postMessage() {}, addEventListener(type, listener) { windowListeners.set(type, listener); } };
  const location = { origin: "https://colonist.io" };
  const chrome = {
    storage: { local: { get: async () => ({ recordingEnabled: true }) }, onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener(listener) { statusListener = listener; } },
      sendMessage(message) {
        return new Promise((resolve, reject) => messages.push({ message, resolve, reject }));
      }
    }
  };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(source, { window, location, chrome, crypto: { randomUUID }, Date: Clock,
    setInterval(callback) { tick = callback; } });
  await settle();
  const emit = data => windowListeners.get("message")({ source: window, origin: location.origin,
    data: { source: "colonist-session-collector/v1", ...data } });
  const event = (sequence, data = "fixture") => emit({ type: "event", event: { sequence,
    timestamp: "2026-01-01T00:00:00.000Z", transport: "websocket", payload: { encoding: "text", data } } });
  const status = () => { let result; statusListener({ type: "bridge-status" }, {}, value => result = value); return result; };
  return { emit, event, status, tick: () => tick(), messages, advance: value => now += value };
}

test("pending status includes encoding and storage writes until acknowledged", async () => {
  const h = await harness();
  h.emit({ type: "capture-status", pendingPayloads: 2 });
  assert.equal(h.status().pendingPayloads, 2);
  h.event(1); h.tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.status().queued, 1, "batch removed from queue is still waiting for storage");
  h.messages[0].resolve({ ok: true });
  await settle();
  assert.equal(h.status().queued, 0);
  h.emit({ type: "capture-status", pendingPayloads: 0 });
  assert.equal(h.status().pendingPayloads, 0);
});

test("failed writes retry the same event before saving newly queued events", async () => {
  const h = await harness();
  h.event(1); h.tick();
  h.messages[0].reject(new Error("fixture storage failure"));
  await settle();
  assert.equal(h.status().queued, 1);
  assert.match(h.status().lastError, /fixture storage failure/);
  h.tick();
  assert.equal(h.messages.length, 1, "retry honors backoff");
  h.advance(1000); h.tick();
  assert.equal(h.messages[1].message.events[0].sequence, 1);
  h.event(2);
  assert.equal(h.status().queued, 2);
  h.messages[1].resolve({ ok: true }); await settle();
  assert.equal(h.messages[2].message.events[0].sequence, 2);
  h.messages[2].resolve({ ok: true }); await settle();
  assert.equal(h.status().queued, 0);
  assert.equal(h.status().lastError, null);
});

test("a drop during the last in-flight batch is persisted without another event", async () => {
  const h = await harness();
  h.event(1); h.tick();
  h.event(2, "x".repeat(32 * 1024 * 1024));
  assert.equal(h.status().dropped, 1);
  assert.equal(h.messages[0].message.dropped, 0);
  h.messages[0].resolve({ ok: true }); await settle();
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].message.events.length, 0);
  assert.equal(h.messages[1].message.dropped, 1);
  assert.equal(h.status().queued, 1, "diagnostics update still awaits acknowledgement");
  h.messages[1].resolve({ ok: true }); await settle();
  h.tick();
  assert.equal(h.messages.length, 2, "acknowledged diagnostics do not cause a write loop");
  assert.equal(h.status().queued, 0);
});
