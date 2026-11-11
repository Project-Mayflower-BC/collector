import test from "node:test";
import assert from "node:assert/strict";
import { classifyHttp, isHeartbeat, observeGame, newGameState, resetGameStream, finishGame, gameSummary } from "../filter.js";
import { decodePayload, toBase64 } from "../decode.js";
import { NetworkCapture } from "../network.js";
import { EventWriter } from "../writer.js";

// Minimal MessagePack encoder for fixtures (fixmap/fixstr/fixarray/positive ints/uint32/uint64).
export function pack(value) {
  const out = [];
  const utf8 = text => [...new TextEncoder().encode(text)];
  (function write(item) {
    if (item === null) out.push(0xc0);
    else if (typeof item === "boolean") out.push(item ? 0xc3 : 0xc2);
    else if (typeof item === "number") {
      if (item >= 0 && item < 128) out.push(item);
      else if (item >= 0 && item < 2 ** 32) out.push(0xce, item >>> 24, (item >>> 16) & 255, (item >>> 8) & 255, item & 255);
      else { const big = BigInt(item); out.push(0xcf); for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((big >> shift) & 255n)); }
    } else if (typeof item === "string") { const bytes = utf8(item); out.push(0xa0 | bytes.length, ...bytes); }
    else if (Array.isArray(item)) { out.push(0x90 | item.length); item.forEach(write); }
    else { const entries = Object.entries(item); out.push(0x80 | entries.length); for (const [key, inner] of entries) { write(key); write(inner); } }
  })(value);
  return Uint8Array.from(out);
}
const b64 = bytes => ({ encoding: "base64", data: toBase64(bytes), byteLength: bytes.length });
const message = (direction, bytes, extra = {}) => ({ transport: "websocket", kind: "message", direction, payload: b64(bytes), ...extra });
// Exact heartbeat bytes from a live recording.
const REAL_INCOMING_HEARTBEAT = Uint8Array.from(Buffer.from("gqJpZKMxMzakZGF0YYGpdGltZXN0YW1wzwAAAaGedWyM", "base64"));
const outgoingHeartbeat = Uint8Array.from([4, 8, 0, ...pack({ id: "136", data: { timestamp: 1793659858060 } })]);
const game = (type, sequence, payload = {}) => pack({ id: "130", data: { type, payload, sequence } });

test("HTTP noise: analytics and static assets are dropped; player and game endpoints are kept", () => {
  assert.equal(classifyHttp("https://colonist.io/api/analytic-events"), "analytics");
  assert.equal(classifyHttp("https://colonist.io/dist/assets/game_spritesheet_0.47fb.json"), "static");
  assert.equal(classifyHttp("https://colonist.io/dist/locales/en_strings.abc.json"), "static");
  assert.equal(classifyHttp("https://colonist.io/cdn-cgi/challenge-platform/h/g/c/x"), "static");
  for (const kept of ["/api/profile/someone/history", "/api/profile/friends", "/api/profile/someone/ranked/22",
    "/api/user-state", "/api/replay/data-from-game-id", "/api/mode-selector", "/data/rooms.json", "/api/analytic-events-v2"]) {
    assert.equal(classifyHttp(`https://colonist.io${kept}`), null, kept);
  }
});

test("heartbeats are recognised exactly in both directions; game and look-alike messages are not", () => {
  assert.equal(isHeartbeat(message("incoming", REAL_INCOMING_HEARTBEAT)), true);
  assert.equal(isHeartbeat(message("outgoing", outgoingHeartbeat)), true);
  assert.equal(isHeartbeat(message("incoming", game(91, 5))), false);
  assert.equal(isHeartbeat(message("incoming", pack({ id: "136", data: { timestamp: 1, extra: 2 } }))), false);
  assert.equal(isHeartbeat(message("incoming", pack({ id: "137", data: { timestamp: 1 } }))), false);
  assert.equal(isHeartbeat({ ...message("incoming", REAL_INCOMING_HEARTBEAT), kind: "control" }), false);
  assert.equal(isHeartbeat({ kind: "message", direction: "incoming", payload: { encoding: "text", data: "{}" } }), false);
});

test("a complete game stream produces no warnings", () => {
  const state = newGameState();
  const warnings = [[6, 1], [1, 2], [59, 3], [4, 4], [91, 5], [28, 6], [45, 7], [91, 8]]
    .flatMap(([type, sequence]) => observeGame(state, { type, sequence }, { connectionId: "ws-1" }));
  assert.deepEqual(warnings, []);
  assert.deepEqual(finishGame(state), []);
  assert.equal(gameSummary(state), "8 game messages · board snapshot ✓ · no gaps · result ✓");
});

test("joining mid-game warns about the late start and the missing snapshot (the Oct 21 case)", () => {
  const state = newGameState();
  const warnings = [[28, 12], [91, 13], [91, 14]].flatMap(([type, sequence]) => observeGame(state, { type, sequence }));
  assert.deepEqual(warnings.map(warning => warning.code), ["late_start", "missing_snapshot"]);
  assert.match(warnings[0].message, /messages 1–11 were missed/);
  assert.equal(gameSummary(state), "3 game messages · no board snapshot · no gaps");
});

test("sequence gaps are counted (the Oct 25 worker-restart case)", () => {
  const state = newGameState();
  for (const [type, sequence] of [[6, 1], [1, 2], [4, 3]]) observeGame(state, { type, sequence });
  const gap = observeGame(state, { type: 91, sequence: 34 });
  assert.equal(gap[0].code, "sequence_gap");
  assert.deepEqual([gap[0].missingFrom, gap[0].missingTo], [4, 33]);
  observeGame(state, { type: 91, sequence: 40 });
  assert.equal(state.missing, 35);
  assert.equal(state.gaps, 2);
  assert.deepEqual(finishGame(state).map(warning => warning.code), ["no_result"]);
});

test("a reload or a new game restarts the stream instead of reporting a gap", () => {
  const state = newGameState();
  for (const [type, sequence] of [[6, 1], [1, 2], [4, 3], [91, 4]]) observeGame(state, { type, sequence }, { connectionId: "a" });
  resetGameStream(state);
  assert.deepEqual([[6, 1], [1, 2], [4, 3]].flatMap(([type, sequence]) => observeGame(state, { type, sequence }, { connectionId: "b" })), []);
  // Same socket, numbering restarts: a second game.
  assert.deepEqual([[6, 1], [1, 2], [4, 3]].flatMap(([type, sequence]) => observeGame(state, { type, sequence }, { connectionId: "b" })), []);
  // A snapshot at a later sequence (for example after a reconnect) is not a late start.
  resetGameStream(state);
  assert.deepEqual(observeGame(state, { type: 4, sequence: 300 }, { connectionId: "c" }), []);
  assert.equal(state.missing, 0);
});

test("stored warnings are capped while the total keeps counting", () => {
  const state = newGameState();
  observeGame(state, { type: 4, sequence: 1 });
  for (let i = 0; i < 60; i++) observeGame(state, { type: 91, sequence: 3 + i * 2 });
  assert.equal(state.warningCount, 60);
  assert.equal(state.warnings.length, 50);
  assert.equal(state.lastWarning.code, "sequence_gap");
});

test("network capture drops heartbeats and noise HTTP, keeps game messages, and logs game warnings", async () => {
  const saved = [];
  const writer = new EventWriter({ id: "fixture" }, async (_metadata, events) => { saved.push(...events); });
  const capture = new NetworkCapture(writer, async () => ({ body: "{}", base64Encoded: false }), () => {});
  capture.mainFrameId = "main";
  const frame = (method, bytes) => capture.handle(method, { requestId: "ws", timestamp: 1, response: { opcode: 2, payloadData: toBase64(bytes) } });
  await capture.handle("Network.webSocketCreated", { requestId: "ws", url: "wss://socket.svr.colonist.io/?version=2" });
  await frame("Network.webSocketFrameReceived", REAL_INCOMING_HEARTBEAT);
  await frame("Network.webSocketFrameSent", outgoingHeartbeat);
  await frame("Network.webSocketFrameReceived", game(28, 12));
  await frame("Network.webSocketFrameReceived", game(91, 13));
  await capture.handle("Network.requestWillBeSent", { requestId: "a", type: "XHR", request: { url: "https://colonist.io/api/analytic-events", method: "POST" } });
  await capture.handle("Network.requestWillBeSent", { requestId: "s", type: "XHR", request: { url: "https://colonist.io/dist/locales/en.json", method: "GET" } });
  await capture.handle("Network.requestWillBeSent", { requestId: "p", type: "XHR", request: { url: "https://colonist.io/api/profile/friends", method: "GET" } });
  await capture.handle("Network.responseReceived", { requestId: "p", response: { url: "https://colonist.io/api/profile/friends", mimeType: "application/json", status: 200 } });
  await capture.handle("Network.loadingFinished", { requestId: "p", encodedDataLength: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writer.metadata.filtered, { heartbeat: { count: 2, bytes: REAL_INCOMING_HEARTBEAT.length + outgoingHeartbeat.length },
    analytics: { count: 1, bytes: 0 }, static: { count: 1, bytes: 0 } });
  assert.equal(writer.metadata.webSocketMessageCount, 4, "heartbeats still show the connection is alive");
  assert.equal(saved.filter(event => event.kind === "message").length, 2);
  assert.deepEqual(saved.filter(event => event.kind === "game-warning").map(event => event.code), ["late_start", "missing_snapshot"]);
  assert.ok(saved.some(event => event.url === "https://colonist.io/api/profile/friends"));
  assert.equal(writer.metadata.game.missing, 0);
});

test("outgoing frames on unverified (URL-less) sockets decode", () => {
  const frame = Uint8Array.from([3, 1, 6, ...new TextEncoder().encode("018F07"), ...pack({ action: 66, payload: 1, sequence: 2 })]);
  const event = { transport: "websocket", direction: "outgoing", url: null, unverified: true };
  assert.equal(decodePayload(b64(frame), event).format, "colonist-client-msgpack");
  assert.equal(decodePayload(b64(frame), { ...event, unverified: undefined }).format, "binary", "a URL-less event must be marked unverified");
});

test("without a diff, a missing snapshot is reported after a short grace period", () => {
  const state = newGameState();
  const codes = [];
  for (let sequence = 1; sequence <= 12; sequence++) codes.push(...observeGame(state, { type: 59, sequence }).map(warning => warning.code));
  assert.deepEqual(codes, ["missing_snapshot"]);
});
