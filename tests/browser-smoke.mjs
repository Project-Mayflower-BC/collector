// No live Colonist traffic: HTTPS requests and WebSocket messages are mocked in Chromium.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await fs.mkdir(path.join(root, "tmp"), { recursive: true });
const profile = await fs.mkdtemp(path.join(root, "tmp", "browser-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", headless: true, acceptDownloads: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
const errors = [];
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
try {
  await context.route("https://**/*", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/abort-fixture") return new Promise(resolve => setTimeout(resolve, 200)).then(() =>
      route.fulfill({ contentType: "application/json", body: '{"fixture":"aborted"}' }).catch(() => {}));
    if (url.pathname.startsWith("/api/")) return route.fulfill({ contentType: "application/json", body: '{"fixture":"http","type":4}' });
    return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Collector fixture</title><body>Local test fixture</body>" });
  });
  await context.routeWebSocket("wss://**/*", ws => {
    ws.onMessage(message => {
      ws.send(message);
      if (message === "binary-please") ws.send(Buffer.from([0x81, 0xa4, 116, 121, 112, 101, 91]));
    });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto("https://colonist.io/__collector_fixture__");
  await page.evaluate(async () => {
    window.fixtureSocket = new WebSocket("wss://socket.svr.colonist.io/?version=2&token=secret-fixture");
    await new Promise(resolve => fixtureSocket.addEventListener("open", resolve, { once: true }));
    fixtureSocket.send('{"fixture":"socket","type":130}');
    fixtureSocket.send("binary-please");
    fixtureSocket.send(Uint8Array.from([3, 1, 6, ...new TextEncoder().encode("01a234"),
      0x83, 0xa6, ...new TextEncoder().encode("action"), 15,
      0xa7, ...new TextEncoder().encode("payload"), 18,
      0xa8, ...new TextEncoder().encode("sequence"), 5]));
    const bytes = Uint8Array.of(0, 128, 255);
    fixtureSocket.send(bytes);
    bytes.fill(42); // Recording must preserve the bytes at send time.
    const response = await fetch("/api/collector-fixture");
    window.fixtureResponse = await response.json();
    await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/xhr-fixture");
      xhr.responseType = "json";
      xhr.onload = resolve;
      xhr.send();
    });
    // Reusing an aborted XHR must not retain the earlier response listener.
    await new Promise(resolve => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/abort-fixture");
      xhr.send();
      xhr.abort();
      xhr.open("GET", "/api/reused-fixture");
      xhr.onload = resolve;
      xhr.send();
    });
    const external = new WebSocket("wss://example.test/socket");
    await new Promise(resolve => external.addEventListener("open", resolve, { once: true }));
    external.send("must-not-record-external");
    external.close();
  });
  assert.deepEqual(await page.evaluate(() => fixtureResponse), { fixture: "http", type: 4 });
  const viewer = await context.newPage();
  await viewer.goto(`chrome-extension://${extensionId}/viewer.html`);
  const read = () => viewer.evaluate(async () => {
    const db = await import("./db.js");
    const sessions = await db.listSessions();
    return sessions.length ? db.readSession(sessions[0].id) : null;
  });
  let recording;
  for (let attempt = 0; attempt < 40; attempt++) {
    recording = await read();
    if (recording?.events.some(event => event.transport === "xhr") && recording.events.filter(event => event.kind === "message").length >= 7) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(recording?.events.some(event => event.transport === "fetch"), "fetch response persisted");
  assert.ok(recording.events.some(event => event.transport === "xhr"), "XHR response persisted");
  assert.equal(recording.events.filter(event => event.url?.includes("/api/reused-fixture")).length, 1);
  assert.ok(!recording.events.some(event => event.url?.includes("/api/abort-fixture")), "aborted XHR listener removed");
  assert.ok(recording.events.some(event => event.direction === "incoming" && event.payload?.encoding === "base64"), "binary incoming persisted");
  assert.ok(recording.events.some(event => event.direction === "outgoing" && event.payload?.data === "AID/"), "typed array copied before caller mutation");
  assert.ok(recording.events.every(event => !event.url?.includes("example.test")), "external endpoint excluded");
  assert.ok(recording.events.every(event => !event.url?.includes("secret-fixture")), "URL token removed");
  assert.ok(recording.events.every((event, i, events) => i === 0 || event.sequence > events[i - 1].sequence), "stored observation order preserved");

  // Hold a Blob conversion open: the popup must not report the recorder idle.
  const sourceTabId = recording.session.tabId;
  await page.evaluate(() => {
    const original = Blob.prototype.arrayBuffer;
    const waiting = [];
    window.releaseBlobCapture = () => {
      for (const release of waiting.splice(0)) release();
      Blob.prototype.arrayBuffer = original;
    };
    window.delayedBlob = new Blob(['{"fixture":"delayed-blob"}']);
    Blob.prototype.arrayBuffer = function () {
      if (this === delayedBlob) return new Promise(resolve => {
        waiting.push(() => resolve(Reflect.apply(original, this, [])));
      });
      return Reflect.apply(original, this, []);
    };
    // Dispatch through the real message listener without making Playwright's
    // mocked socket transport wait on the same intentionally held Blob.
    fixtureSocket.dispatchEvent(new MessageEvent("message", { data: delayedBlob }));
  });
  async function waitForBridge(predicate) {
    let state;
    for (let attempt = 0; attempt < 100; attempt++) {
      state = await viewer.evaluate(tabId => chrome.tabs.sendMessage(tabId, { type: "bridge-status" }), sourceTabId);
      if (predicate(state)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Timed out waiting for bridge status: ${JSON.stringify(state)}`);
  }
  await waitForBridge(state => state.pendingPayloads > 0);
  await page.evaluate(() => releaseBlobCapture());
  await waitForBridge(state => state.pendingPayloads === 0 && state.queued === 0);
  recording = await read();
  assert.ok(recording.events.some(event => event.direction === "incoming" && event.payload?.data === "eyJmaXh0dXJlIjoiZGVsYXllZC1ibG9iIn0="), "pending Blob persisted before idle");

  // Pausing takes effect in the page; resuming the same socket must work.
  await viewer.evaluate(() => chrome.storage.local.set({ recordingEnabled: false }));
  await page.waitForTimeout(150);
  await page.evaluate(() => fixtureSocket.send("must-not-record-paused"));
  await page.waitForTimeout(350);
  await viewer.evaluate(() => chrome.storage.local.set({ recordingEnabled: true }));
  await page.waitForTimeout(150);
  await page.evaluate(() => fixtureSocket.send("record-after-resume"));
  await page.evaluate(() => {
    for (let i = 0; i < 120; i++) fixtureSocket.send(JSON.stringify({ burst: i }));
  });
  // IndexedDB writes and bridge acknowledgements are asynchronous; wait for
  // persisted burst completion instead of assuming a fixed 350 ms flush time.
  for (let attempt = 0; attempt < 100; attempt++) {
    recording = await read();
    if (recording.events.filter(event => event.direction === "incoming" && event.payload?.encoding === "text" && event.payload.data.startsWith('{"burst":')).length === 120) break;
    await page.waitForTimeout(100);
  }
  assert.ok(!recording.events.some(event => event.payload?.data === "must-not-record-paused"));
  assert.ok(recording.events.some(event => event.payload?.data === "record-after-resume"));
  assert.ok(recording.events.some(event => event.kind === "pause"));
  assert.ok(recording.events.some(event => event.kind === "resume"));
  assert.equal(recording.events.filter(event => event.direction === "incoming" && event.payload?.encoding === "text" && event.payload.data.startsWith('{"burst":')).length, 120, "burst stored across batches");

  // DB retries must be idempotent, without inflating the event count.
  const count = recording.events.length;
  await viewer.evaluate(async recording => {
    const { saveBatch } = await import("./db.js");
    await saveBatch(recording.session, recording.events);
  }, recording);
  assert.equal((await read()).session.eventCount, count);
  await page.close();
  await viewer.reload();
  assert.equal((await read()).events.length, count, "recording survives closing source tab");
  await viewer.locator("#refresh").click();
  await viewer.locator("#search").fill('"type": 91');
  assert.ok(await viewer.locator("#events tr").count() > 0, "decoded MessagePack searchable");
  await viewer.locator("#events tr").first().click();
  assert.match(await viewer.locator("#decoded").textContent(), /msgpack/);
  await viewer.locator("#search").fill("colonist-client-msgpack");
  assert.equal(await viewer.locator("#events tr").count(), 1, "only outgoing fixture decoded as client framing");
  await viewer.locator("#events tr").first().click();
  assert.match(await viewer.locator("#decoded").textContent(), /"action": 15/);
  const downloadPromise = viewer.waitForEvent("download");
  await viewer.locator("#export").click();
  const download = await downloadPromise;
  const saved = JSON.parse(await fs.readFile(await download.path(), "utf8"));
  assert.equal(saved.schema, "colonist-session-collector/v1");
  assert.equal(saved.events.length, count);
  assert.ok(saved.events.some(event => event.decoded?.format === "msgpack" && event.decoded.value.type === 91));
  assert.ok(saved.events.some(event => event.decoded?.format === "colonist-client-msgpack" && event.decoded.value.action === 15));
  await viewer.screenshot({ path: path.join(root, "tmp", "recordings-smoke.png"), fullPage: true });

  const unrelated = await context.newPage();
  await unrelated.goto("https://colonist.io.example.test/fixture");
  assert.equal(await unrelated.evaluate(() => Boolean(window[Symbol.for("colonist-session-collector.installed")])), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, events: count, export: download.suggestedFilename(), extensionId, screenshot: "tmp/recordings-smoke.png" }));
} finally {
  await context.close();
}
