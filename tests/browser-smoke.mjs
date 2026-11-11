// Real CDP events from loopback TLS/WSS. No live Colonist traffic or signed-in browser.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const playwrightPath = process.env.PLAYWRIGHT_MODULE || "playwright";
const { chromium } = require(playwrightPath);
const dependencyRequire = createRequire(require.resolve(playwrightPath));
const WebSocket = dependencyRequire("faye-websocket");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const certificate = JSON.parse(execFileSync(process.env.TEST_PYTHON || "python", [path.join(root, "tests", "test-certificate.py")], { encoding: "utf8" }));
const server = https.createServer(certificate, (req, res) => {
  if (req.url.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end('{"fixture":"http","type":4}');
  } else {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>Local collector fixture</title><body>Local collector fixture</body>");
  }
});
const sockets = new Set();
const connections = new Set();
server.on("connection", socket => { connections.add(socket); socket.on("close", () => connections.delete(socket)); });
server.on("upgrade", (req, socket, head) => {
  if (!WebSocket.isWebSocket(req)) { socket.destroy(); return; }
  const ws = new WebSocket(req, socket, head);
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  ws.on("message", event => {
    ws.send(event.data);
    if (event.data === "binary-please") ws.send(Buffer.from([0x81, 0xa4, 116, 121, 112, 101, 91]));
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await fs.mkdir(path.join(root, "tmp"), { recursive: true });
// Outside the extension directory: Chromium scans an unpacked extension's folder when loading it.
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "collector-smoke-"));
let context;
const errors = [];
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(read, predicate, label) {
  let value;
  for (let attempt = 0; attempt < 300; attempt++) {
    value = await read();
    if (predicate(value)) return value;
    await delay();
  }
  const summary = value?.events ? { session: value.session, events: value.events.length,
    incomingBurst: value.events.filter(event => event.direction === "incoming" && event.payload?.data.startsWith('{"burst":')).length,
    lastSequence: value.events.at(-1)?.sequence } : value;
  assert.fail(`Timed out: ${label}: ${JSON.stringify(summary)}`);
}
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium", headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-proxy-server",
      "--ignore-certificate-errors", "--host-resolver-rules=MAP colonist.io 127.0.0.1, MAP socket.svr.colonist.io 127.0.0.1, MAP colonist.io.example.test 127.0.0.1"]
  });
  context.setDefaultTimeout(15000);
  console.log("Isolated Chromium launched");
  // Wait for the worker before routing: interception set up mid-load can stall the extension's
  // service worker. Polling also avoids missing a serviceworker event that has already fired.
  const worker = await until(() => context.serviceWorkers()[0], Boolean, "extension service worker");
  // Fail closed: only this test server is accessible to page requests.
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.protocol === "chrome-extension:") return route.continue();
    if (url.protocol === "https:" && url.port === String(port) &&
      ["colonist.io", "colonist.io.example.test"].includes(url.hostname)) return route.continue();
    return route.abort();
  });
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`https://colonist.io:${port}/fixture`);
  const originals = await page.evaluate(() => {
    window.beforeCollector = { WebSocket, send: WebSocket.prototype.send, fetch, open: XMLHttpRequest.prototype.open, xhrSend: XMLHttpRequest.prototype.send };
    window.collectorBusEvents = 0;
    addEventListener("message", event => { if (event.data?.source === "colonist-session-collector/v1") collectorBusEvents++; });
    return Object.values(beforeCollector).map(value => Function.prototype.toString.call(value));
  });
  let viewer = await context.newPage();
  await viewer.goto(`chrome-extension://${extensionId}/viewer.html`);
  console.log("Fixture and extension viewer loaded");
  const send = message => viewer.evaluate(message => chrome.runtime.sendMessage(message), message);
  const targets = await viewer.evaluate(() => chrome.debugger.getTargets());
  const tabId = targets.find(item => item.url === `https://colonist.io:${port}/fixture`).tabId;
  const initialStart = await send({ type: "recorder-start", tabId });
  assert.equal(initialStart.ok, true, JSON.stringify(initialStart));
  console.log("Chrome debugger attached");
  assert.equal((await send({ type: "recorder-start", tabId })).ok, false, "duplicate start rejected");
  const read = () => viewer.evaluate(async () => {
    const db = await import("./db.js");
    const sessions = await db.listSessions();
    return sessions.length ? db.readSession(sessions[0].id) : null;
  });
  const state = () => send({ type: "recorder-status" });
  await page.evaluate(async port => { await fetch(`https://colonist.io:${port}/api/before-socket`); }, port);
  await until(read, value => value.events.some(event => event.transport === "fetch"), "HTTP-only capture saved");
  assert.equal((await state()).webSocketMessageCount, 0, "HTTP traffic alone does not establish game connection capture");
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await until(() => popup.locator("#connection-warning").isVisible(), Boolean, "missing game connection warning");
  await popup.close();
  await page.evaluate(async port => {
    const ws = window.fixtureSocket = new WebSocket(`wss://socket.svr.colonist.io:${port}/?token=secret-fixture`);
    window.received = [];
    ws.addEventListener("message", event => received.push(event.data));
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Local WSS connection timed out")), 10000);
      ws.onopen = () => { clearTimeout(timer); resolve(); }; ws.onerror = () => { clearTimeout(timer); reject(new Error("Local WSS fixture failed")); }; });
    ws.send('{"fixture":"socket","type":130}');
    ws.send("binary-please");
    ws.send(Uint8Array.from([3, 1, 6, ...new TextEncoder().encode("01a234"),
      0x83, 0xa6, ...new TextEncoder().encode("action"), 15,
      0xa7, ...new TextEncoder().encode("payload"), 18,
      0xa8, ...new TextEncoder().encode("sequence"), 5]));
    const bytes = Uint8Array.of(0, 128, 255);
    ws.send(bytes);
    bytes.fill(42);
    window.fixtureResponse = await (await fetch("/api/fetch")).json();
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/xhr");
      xhr.onload = resolve;
      xhr.onerror = reject;
      xhr.send();
    });
    // Real loopback TLS endpoint under a lookalike domain must still be excluded.
    const external = new WebSocket(`wss://colonist.io.example.test:${port}/socket`);
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("External fixture timed out")), 10000);
      external.onopen = () => { clearTimeout(timer); resolve(); }; external.onerror = () => { clearTimeout(timer); reject(new Error("External fixture failed")); }; });
    external.send("must-not-record-external");
    external.close();
    await fetch(`https://colonist.io.example.test:${port}/api/external`);
  }, port);
  assert.deepEqual(await page.evaluate(() => fixtureResponse), { fixture: "http", type: 4 });
  console.log("Real TLS/WSS fixture traffic completed");
  let recording = await until(read, value => value?.events.some(event => event.transport === "xhr") &&
    value.events.filter(event => event.kind === "message").length >= 9, "initial messages and HTTP");
  assert.ok(recording.events.some(event => event.transport === "fetch" && event.payload?.data.includes('"fixture":"http"')), "CDP HTTP body retrieved");
  assert.ok(recording.events.some(event => event.direction === "outgoing" && event.payload?.data === "AID/"), "typed array preserved");
  assert.ok(recording.events.some(event => event.direction === "incoming" && event.payload?.encoding === "base64"), "binary incoming");
  assert.ok(recording.events.every(event => !event.url?.includes("example.test") && !event.url?.includes("secret-fixture")), "domain/token scope");
  assert.deepEqual(await page.evaluate(() => Object.values(beforeCollector).map(value => Function.prototype.toString.call(value))), originals);
  assert.equal(await page.evaluate(() => beforeCollector.WebSocket === WebSocket && beforeCollector.send === WebSocket.prototype.send &&
    beforeCollector.fetch === fetch && beforeCollector.open === XMLHttpRequest.prototype.open && beforeCollector.xhrSend === XMLHttpRequest.prototype.send), true, "native functions unchanged");
  assert.equal(await page.evaluate(() => collectorBusEvents), 0, "no collector window message bridge");
  assert.equal(await page.evaluate(() => Boolean(window[Symbol.for("colonist-session-collector.installed")])), false, "no page hook marker");
  const checkpoint = await viewer.evaluate(async id => (await import("./db.js")).readCheckpoint(id), recording.session.id);
  assert.ok(checkpoint.sequence >= Math.max(...recording.events.map(event => event.sequence)));
  assert.equal(checkpoint.sockets.length, 1, "recovery checkpoint retains the live Colonist socket only");
  // Close the extension UI and exceed the normal 30-second worker idle threshold.
  // The health timer runs only while this explicit recording is attached.
  const idleMs = Number(process.env.COLLECTOR_IDLE_MS || 65000);
  console.log(`Testing ${idleMs} ms with extension UI closed`);
  await viewer.close();
  await new Promise(resolve => setTimeout(resolve, idleMs));
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${extensionId}/viewer.html`);
  // Keep the helpers pointing to the same page object by opening a replacement
  // viewer below rather than touching the fixture tab or recreating its socket.
  viewer = reopened;
  assert.equal((await state()).activeTabId, tabId, "recording survives idle with popup/viewer closed");
  assert.equal((await state()).sessionId, recording.session.id);
  assert.equal(await viewer.evaluate(() => chrome.action.getBadgeText({})), "REC");
  await page.evaluate(() => fixtureSocket.send("after-idle"));
  await until(read, value => value.events.some(event => event.payload?.data === "after-idle"), "post-idle message captured");
  console.log("Closed-UI idle check passed");
  await viewer.locator("#refresh").click();
  await until(() => viewer.locator("#export").textContent(), value => value === "Stop & save", "live recording offers Stop & save");
  assert.equal(await viewer.locator("#delete").isDisabled(), true, "live recording cannot be deleted");
  await viewer.evaluate(() => chrome.storage.local.set({ recordingEnabled: false }));
  await until(state, value => !value.enabled, "paused state");
  await page.evaluate(async () => {
    fixtureSocket.send("must-not-record-paused");
    await new Promise(resolve => {
      const listener = event => { if (event.data === "must-not-record-paused") { fixtureSocket.removeEventListener("message", listener); resolve(); } };
      fixtureSocket.addEventListener("message", listener);
    });
  });
  await delay();
  await viewer.evaluate(() => chrome.storage.local.set({ recordingEnabled: true }));
  await until(state, value => value.enabled, "resumed state");
  await page.bringToFront();
  await page.evaluate(() => {
    fixtureSocket.send("record-after-resume");
    for (let i = 0; i < 120; i++) fixtureSocket.send(JSON.stringify({ burst: i }));
  });
  recording = await until(read, value => value.events.filter(event => event.direction === "incoming" && event.payload?.data.startsWith('{"burst":')).length === 120, "burst persisted");
  assert.ok(!recording.events.some(event => event.payload?.data === "must-not-record-paused"));
  assert.ok(recording.events.some(event => event.payload?.data === "record-after-resume"));
  await page.reload();
  assert.equal((await state()).activeTabId, tabId, "attachment survives same-site reload");
  await page.evaluate(() => fetch("/api/after-reload"));
  await until(read, value => value.events.some(event => event.url?.endsWith("/api/after-reload")), "reload HTTP persisted");
  // Search and decoding of the live recording, before stopping clears it from storage.
  await viewer.locator("#refresh").click();
  await viewer.locator("#search").fill('"type": 91');
  assert.ok(await viewer.locator("#events tr").count() > 0, "MessagePack searchable");
  await viewer.locator("#search").fill("colonist-client-msgpack");
  assert.equal(await viewer.locator("#events tr").count(), 1);
  await viewer.locator("#events tr").first().click();
  assert.match(await viewer.locator("#decoded").textContent(), /"action": 15/);
  await viewer.locator("#search").fill("");
  const files = count => until(() => viewer.evaluate(() => chrome.downloads.search({ state: "complete", orderBy: ["startTime"] })),
    items => items.length >= count, `${count} JSON file(s) saved to Downloads`);
  const savedFile = async item => JSON.parse(await fs.readFile(item.filename, "utf8"));
  const stored = () => viewer.evaluate(async () => (await (await import("./db.js")).listSessions()).length);
  await page.goto(`https://colonist.io.example.test:${port}/outside`);
  await until(state, value => value.activeTabId === null && !value.saving, "automatic detach outside scope saves the file");
  assert.equal((await send({ type: "recorder-start", tabId })).ok, false, "lookalike attachment rejected");
  const [first] = await files(1);
  const saved = await savedFile(first);
  assert.equal(saved.extensionVersion, "0.4.0");
  assert.equal(saved.session.id, recording.session.id);
  assert.ok(saved.events.some(event => event.kind === "stop"));
  assert.ok(saved.events.some(event => event.decoded?.format === "msgpack" && event.decoded.value.type === 91));
  assert.ok(saved.events.some(event => event.url?.endsWith("/api/after-reload")));
  assert.ok(saved.events.every((event, i) => !i || event.sequence > saved.events[i - 1].sequence));
  assert.equal(await stored(), 0, "saving the JSON clears the local copy");
  assert.match((await state()).notice, /Saved colonist-.*\.json to Downloads/);
  // A recording left in storage (e.g. after a failed save) is saved from the viewer, then cleared.
  const count = saved.events.length;
  const restored = { session: saved.session, events: saved.events.map(({ decoded, ...event }) => event) };
  await viewer.evaluate(async recording => { const { saveBatch } = await import("./db.js"); await saveBatch(recording.session, recording.events); await saveBatch(recording.session, recording.events); }, restored);
  assert.equal((await viewer.evaluate(async id => (await import("./db.js")).readSession(id), saved.session.id)).session.eventCount, count, "duplicate writes idempotent");
  await page.close();
  await viewer.reload();
  await viewer.locator("#export").click();
  await until(() => viewer.locator("#summary").textContent(), value => value.includes("cleared it from the extension"), "viewer save and clear");
  assert.equal((await savedFile((await files(2))[1])).events.length, count);
  assert.equal(await stored(), 0);
  // Explicit stop also releases the debugger; opening DevTools/user cancellation is an interruption.
  const second = await context.newPage();
  await second.goto(`https://colonist.io:${port}/second`);
  const secondId = (await viewer.evaluate(() => chrome.debugger.getTargets())).find(item => item.url.endsWith("/second")).tabId;
  assert.equal((await send({ type: "recorder-start", tabId: secondId })).ok, true);
  // The viewer's Stop & save stops the live recording, which saves it.
  await viewer.locator("#refresh").click();
  await until(() => viewer.locator("#export").textContent(), value => value === "Stop & save", "Stop & save offered");
  await viewer.locator("#export").click();
  await until(() => viewer.locator("#summary").textContent(), value => /Saved colonist-.*\.json to Downloads/.test(value), "Stop & save completes");
  await until(state, value => value.activeTabId === null && !value.queued && !value.saving, "explicit stop drains and saves");
  assert.equal(await viewer.locator("#error").isHidden(), true);
  assert.equal((await savedFile((await files(3))[2])).session.stopCode, "user_stop");
  assert.equal((await send({ type: "recorder-start", tabId: secondId })).ok, true);
  await second.close();
  await until(state, value => value.activeTabId === null && !value.queued && !value.saving, "closed target detach");
  const closedFile = (await files(4))[3];
  const ended = await savedFile(closedFile);
  assert.ok(ended.events.some(event => event.kind === "gap"), "unexpected detach marked as gap");
  assert.equal(await viewer.evaluate(() => chrome.action.getBadgeText({})), "ERR");
  assert.equal(ended.session.stopCode, "debugger_detached");
  assert.ok(ended.session.detachReason);
  assert.equal((await viewer.evaluate(() => chrome.storage.local.get("recorderNotice"))).recorderNotice.unexpected, true);
  // Saved files open read-only in the viewer.
  await viewer.locator("#open-file").setInputFiles(closedFile.filename);
  await until(() => viewer.locator("#warning").textContent(), value => value.includes("No WebSocket messages captured"), "analytics-only recording warning");
  assert.equal(await viewer.locator("#export").isDisabled(), true);
  await viewer.screenshot({ path: path.join(root, "tmp", "debugger-recordings-smoke.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, events: count, transport: "actual CDP over loopback TLS/WSS", export: saved.session.id, screenshot: "tmp/debugger-recordings-smoke.png" }));
} finally {
  // A failed run can leave the browser unresponsive; never let cleanup hide the error.
  if (context) await Promise.race([context.close(), new Promise(resolve => setTimeout(resolve, 10000))]);
  for (const ws of sockets) ws.close();
  for (const socket of connections) socket.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
}
