import test from "node:test";
import assert from "node:assert/strict";
import { NetworkCapture, PAYLOAD_LIMIT } from "../network.js";
import { EventWriter } from "../writer.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(command = async () => ({ body: '{"fixture":true}', base64Encoded: false })) {
  const saved = new Map();
  const writes = [];
  const writer = new EventWriter({ id: "fixture" }, async (metadata, events) => {
    writes.push(metadata);
    for (const event of events) saved.set(event.sequence, event);
  });
  const leave = [];
  const capture = new NetworkCapture(writer, command, reason => { leave.push(reason); capture.close(reason); });
  capture.mainFrameId = "main";
  return { writer, capture, leave, writes, events: () => [...saved.values()].sort((a, b) => a.sequence - b.sequence) };
}
const socket = (url = "wss://socket.svr.colonist.io/?token=private") => ({ requestId: "ws", url });
const frame = (data = "hello", opcode = 1) => ({ requestId: "ws", timestamp: 123, response: { opcode, payloadData: data } });
async function request(capture, url = "https://colonist.io/api", id = "http", type = "Fetch", mimeType = "application/json") {
  await capture.handle("Network.requestWillBeSent", { requestId: id, type, request: { url, method: "POST", postData: "must-not-save", headers: { Cookie: "private" } } });
  await capture.handle("Network.responseReceived", { requestId: id, response: { url, mimeType, status: 200, headers: { "set-cookie": "private" } } });
}
test("CDP WebSocket text/binary/control preserve bytes and metadata without headers", async () => {
  const h = harness();
  await h.capture.handle("Network.webSocketCreated", socket());
  await h.capture.handle("Network.webSocketHandshakeResponseReceived", { requestId: "ws", response: { status: 101, headers: { Cookie: "private" } } });
  await h.capture.handle("Network.webSocketFrameReceived", frame('{"type":91}'));
  await h.capture.handle("Network.webSocketFrameSent", frame("AID/", 2));
  await h.capture.handle("Network.webSocketFrameReceived", frame("AA==", 9));
  await tick();
  const events = h.events();
  assert.equal(events.length, 5);
  assert.deepEqual(events[3].payload, { encoding: "base64", data: "AID/", byteLength: 3 });
  assert.equal(events[3].direction, "outgoing");
  assert.equal(events[4].kind, "control");
  assert.equal(events[4].payload.byteLength, 1);
  assert.equal(h.writer.metadata.webSocketMessageCount, 2, "control frames do not count as game connection messages");
  assert.ok(h.writer.metadata.lastWebSocketMessageAt);
  assert.ok(events.every(event => !event.url?.includes("private") && !event.headers));
});
test("lookalike/external sockets and HTTP redirects never reach storage", async () => {
  const h = harness();
  await h.capture.handle("Network.webSocketCreated", socket("wss://colonist.io.evil.test/"));
  await h.capture.handle("Network.webSocketFrameReceived", frame());
  await request(h.capture);
  await request(h.capture, "https://external.test/api");
  await h.capture.handle("Network.loadingFinished", { requestId: "http" });
  await request(h.capture, "https://colonist.io/image", "image", "Fetch", "image/png");
  await h.capture.handle("Network.loadingFinished", { requestId: "image" });
  await tick();
  assert.equal(h.events().length, 0);
});
test("pause/resume filters traffic on existing sockets; navigation outside detaches even paused", async () => {
  const h = harness();
  await h.capture.handle("Network.webSocketCreated", socket());
  h.capture.setEnabled(false);
  await h.capture.handle("Network.webSocketFrameReceived", frame("paused"));
  h.capture.setEnabled(true);
  await h.capture.handle("Network.webSocketFrameReceived", frame("resumed"));
  h.capture.setEnabled(false);
  await h.capture.handle("Network.requestWillBeSent", { requestId: "doc", frameId: "main", type: "Document", request: { url: "https://example.test/" } });
  await tick();
  assert.equal(h.leave.length, 1);
  assert.ok(!h.events().some(event => event.payload?.data === "paused"));
  assert.ok(h.events().some(event => event.payload?.data === "resumed"));
});
test("HTTP responses reserve observation order and report pending retrieval and storage", async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  await request(h.capture);
  const unfinished = h.capture.handle("Network.loadingFinished", { requestId: "http", encodedDataLength: 5 });
  assert.equal(h.writer.pendingBodies, 1);
  h.capture.diagnostic("later", "follows HTTP observation");
  release({ body: "gA==", base64Encoded: true });
  await unfinished;
  await tick();
  assert.equal(h.writer.pendingBodies, 0);
  assert.equal(h.events()[0].transport, "fetch");
  assert.equal(h.events()[0].payload.data, "gA==");
  assert.equal(h.events()[1].kind, "later");
  assert.ok(!JSON.stringify(h.events()).includes("must-not-save"));
});
test("HTTP retrieval crossing pause/navigation/stop omits body; failures are explicit", async () => {
  for (const boundary of ["pause", "navigation", "stop"]) {
    let release;
    const h = harness(() => new Promise(resolve => { release = resolve; }));
    await request(h.capture);
    const pending = h.capture.handle("Network.loadingFinished", { requestId: "http" });
    if (boundary === "pause") h.capture.setEnabled(false);
    if (boundary === "navigation") await h.capture.handle("Page.frameNavigated", { frame: { id: "main", url: "https://colonist.io/new" } });
    if (boundary === "stop") h.capture.close("stopped");
    release({ body: "do-not-save", base64Encoded: false });
    await pending;
    await tick();
    assert.ok(h.events().some(event => event.captureError?.includes("boundary")));
    assert.ok(!h.events().some(event => event.payload?.data === "do-not-save"));
  }
  const h = harness(async () => { throw new Error("evicted"); });
  await request(h.capture);
  await h.capture.handle("Network.loadingFinished", { requestId: "http" });
  await tick();
  assert.match(h.events()[0].captureError, /evicted/);
});
test("oversize payloads are omitted with explicit diagnostics", async () => {
  const h = harness();
  await h.capture.handle("Network.webSocketCreated", socket());
  await h.capture.handle("Network.webSocketFrameReceived", frame("a".repeat(PAYLOAD_LIMIT + 1)));
  await request(h.capture);
  await h.capture.handle("Network.loadingFinished", { requestId: "http", encodedDataLength: PAYLOAD_LIMIT + 1 });
  await tick();
  assert.equal(h.events().filter(event => event.payload?.encoding === "omitted").length, 2);
});
test("writer retries identical keys; pending includes unacknowledged writes and late overflow diagnostics", async () => {
  const writes = [], timers = [];
  const writer = new EventWriter({ id: "fixture" }, (meta, events) => new Promise((resolve, reject) => writes.push({ meta, events, resolve, reject })),
    { maxEvents: 1, schedule: callback => timers.push(callback) });
  writer.emit({ transport: "collector", kind: "first" });
  assert.equal(writer.status().queued, 1);
  writer.emit({ transport: "collector", kind: "overflow" });
  assert.equal(writer.status().dropped, 1);
  writes[0].reject(new Error("disk"));
  await tick();
  assert.match(writer.status().lastError, /disk/);
  assert.equal(writer.status().queued, 1);
  timers.shift()();
  assert.deepEqual(writes[1].events, writes[0].events);
  writes[1].resolve();
  await tick();
  assert.equal(writer.status().queued, 0);
  assert.equal(writes[1].meta.captureDropped, 1);
  writer.emit({ kind: "oversize", data: "a".repeat(50) });
  writer.emit({ kind: "dropped-during-last-write" });
  writes[2].resolve();
  await tick();
  assert.equal(writes[3].events.length, 0);
  assert.equal(writes[3].meta.captureDropped, 2);
  writes[3].resolve();
  await tick();
  assert.equal(writer.status().queued, 0);
});
test("a socket first seen mid-stream is adopted and marked unverified; rejected sockets stay ignored", async () => {
  const h = harness();
  await h.capture.handle("Network.webSocketCreated", { requestId: "evil", url: "wss://colonist.io.evil.test/" });
  await h.capture.handle("Network.webSocketFrameReceived", { ...frame("external"), requestId: "evil" });
  await h.capture.handle("Network.webSocketFrameReceived", frame("missed-creation"));
  await h.capture.handle("Network.webSocketFrameSent", frame("second"));
  await tick();
  const events = h.events();
  assert.deepEqual(events.map(event => event.kind), ["connect", "message", "message"]);
  assert.equal(events[0].unverified, true);
  assert.equal(events[0].url, null);
  assert.equal(events[1].payload.data, "missed-creation");
  assert.equal(events[2].connectionId, "ws-ws");
  assert.ok(!events.some(event => event.payload?.data === "external"));
});
