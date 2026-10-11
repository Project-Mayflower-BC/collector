import test from "node:test";
import assert from "node:assert/strict";
import { decodeMessagePack, decodeColonistClientFrame, decodePayload, fromBase64, toBase64, makeExport } from "../decode.js";
import { isColonistUrl, safeUrl } from "../scope.js";
import { readFile } from "node:fs/promises";

test("export, package and extension manifest versions agree", async () => {
  const [manifest, pkg] = await Promise.all(["manifest.json", "package.json"].map(async file =>
    JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"))));
  assert.equal(manifest.version, pkg.version);
  assert.equal(makeExport({ session: {}, events: [] }).extensionVersion, manifest.version);
});

test("domain boundary excludes lookalikes and unrelated protocols", () => {
  for (const url of ["https://colonist.io/", "https://www.colonist.io/", "wss://socket.svr.colonist.io/?version=2"]) assert.ok(isColonistUrl(url));
  for (const url of ["https://evilcolonist.io/", "https://colonist.io.example.com/", "http://colonist.io/", "file:///colonist.io", "not a URL"]) assert.equal(isColonistUrl(url), false);
  assert.equal(isColonistUrl("wss://colonist.io/", ["https:"]), false);
});

test("URLs retain routing information but strip credentials and token parameters", () => {
  const url = new URL(safeUrl("https://user:pass@colonist.io/api?version=2&token=abc&connect.sid=123#game"));
  assert.equal(url.username, ""); assert.equal(url.password, "");
  assert.equal(url.searchParams.get("version"), "2");
  assert.equal(url.searchParams.get("token"), "[redacted]");
  assert.equal(url.searchParams.get("connect.sid"), "[redacted]");
});

test("decodes a representative MessagePack game envelope", () => {
  // {id: 130, data: {type: 91, payload: [null, true, -1]}}
  const bytes = Uint8Array.from([0x82, 0xa2, 105, 100, 0xcc, 130,
    0xa4, 100, 97, 116, 97, 0x82, 0xa4, 116, 121, 112, 101, 91,
    0xa7, 112, 97, 121, 108, 111, 97, 100, 0x93, 0xc0, 0xc3, 0xff]);
  assert.deepEqual(decodeMessagePack(bytes), { id: 130, data: { type: 91, payload: [null, true, -1] } });
  assert.equal(decodePayload({ encoding: "base64", data: toBase64(bytes) }).format, "msgpack");
});

test("preserves 64-bit integers, binary, extensions, and non-finite floats in JSON", () => {
  assert.deepEqual(decodeMessagePack(Uint8Array.of(0xcf, 255, 255, 255, 255, 255, 255, 255, 255)), { $integer64: "18446744073709551615" });
  assert.deepEqual(decodeMessagePack(Uint8Array.of(0xc4, 2, 0, 255)), { $binary: "AP8=", byteLength: 2 });
  assert.deepEqual(decodeMessagePack(Uint8Array.of(0xd4, 255, 42)), { $extension: -1, $binary: "Kg==", byteLength: 1 });
  assert.deepEqual(decodeMessagePack(Uint8Array.of(0xca, 0x7f, 0x80, 0, 0)), { $float: "Infinity" });
  assert.deepEqual(decodeMessagePack(Uint8Array.of(0x81, 1, 2)), { $map: [[1, 2]] });
});

test("rejects malformed lengths, trailing data and nesting without losing raw bytes", () => {
  for (const bytes of [[], [0xdb, 255, 255, 255, 255], [0xdd, 255, 255, 255, 255], [0xc1], [1, 2], [...Array(140).fill(0x91), 0]]) {
    assert.throws(() => decodeMessagePack(Uint8Array.from(bytes)));
  }
  const data = toBase64(Uint8Array.of(0xc1, 0xff));
  assert.equal(decodePayload({ encoding: "base64", data }).format, "binary");
  assert.deepEqual([...fromBase64(data)], [0xc1, 0xff]);
});

test("JSON decoding and export keep original bytes and restore observation order", () => {
  const payload = { encoding: "base64", data: toBase64(new TextEncoder().encode('{"type":4}')) };
  const exported = makeExport({ session: { id: "test" }, events: [
    { sequence: 2, payload: { encoding: "text", data: "not json" } }, { sequence: 1, payload }
  ] });
  assert.deepEqual(exported.events.map(event => event.sequence), [1, 2]);
  assert.deepEqual(exported.events[0].payload, payload);
  assert.deepEqual(exported.events[0].decoded, { format: "json", value: { type: 4 } });
  assert.equal(exported.events[1].decoded.value, "not json");
});

const outgoingContext = { transport: "websocket", direction: "outgoing", url: "wss://socket.svr.colonist.io/?version=2" };
// Synthetic, token-free fixtures using the framing observed in the first real recording.
const actionBody = [0x83, 0xa6, ...new TextEncoder().encode("action"), 15,
  0xa7, ...new TextEncoder().encode("payload"), 18,
  0xa8, ...new TextEncoder().encode("sequence"), 5];
const actionFrame = Uint8Array.from([3, 1, 6, ...new TextEncoder().encode("123456"), ...actionBody]);

test("decodes observed Colonist client framing only in an outgoing Colonist WebSocket", () => {
  const payload = { encoding: "base64", data: toBase64(actionFrame) };
  const decoded = decodePayload(payload, outgoingContext);
  assert.deepEqual(decoded, { format: "colonist-client-msgpack", headerBytes: [3, 1, 6], route: "123456",
    value: { action: 15, payload: 18, sequence: 5 } });
  for (const context of [{}, { ...outgoingContext, direction: "incoming" },
    { ...outgoingContext, transport: "fetch" }, { ...outgoingContext, url: "wss://example.test/" }]) {
    assert.equal(decodePayload(payload, context).format, "binary");
  }
  const exported = makeExport({ session: {}, events: [{ sequence: 1, ...outgoingContext, payload }] });
  assert.deepEqual(exported.events[0].decoded, decoded);
  assert.deepEqual(exported.events[0].payload, payload);
  const alphanumericRoute = Uint8Array.from([3, 1, 6, ...new TextEncoder().encode("01a234"), ...actionBody]);
  assert.equal(decodePayload({ encoding: "base64", data: toBase64(alphanumericRoute) }, outgoingContext).route, "01a234");
});

test("recognizes lobby and heartbeat client frames without assigning header semantics", () => {
  const lobby = Uint8Array.from([2, 10, 5, ...new TextEncoder().encode("lobby"),
    0x81, 0xa4, ...new TextEncoder().encode("type"), 0xa6, ...new TextEncoder().encode("addBot")]);
  assert.equal(decodeColonistClientFrame(lobby).value.type, "addBot");
  const heartbeat = Uint8Array.from([4, 8, 0, 0x82, 0xa2, 105, 100, 0xa3, 49, 51, 54,
    0xa4, 100, 97, 116, 97, 0x81, 0xa9, ...new TextEncoder().encode("timestamp"), 1]);
  assert.deepEqual(decodeColonistClientFrame(heartbeat).value, { id: "136", data: { timestamp: 1 } });
});

test("rejects truncated, unknown and malformed client frames while retaining raw bytes", () => {
  for (const frame of [actionFrame.subarray(0, 8), Uint8Array.of(3, 1, 255, 0),
    Uint8Array.from([9, ...actionFrame.subarray(1)]), Uint8Array.from([...actionFrame, 0]),
    Uint8Array.of(4, 8, 0, 1), Uint8Array.of(3, 1, 1, 65, 0x80)]) {
    assert.throws(() => decodeColonistClientFrame(frame));
    const payload = { encoding: "base64", data: toBase64(frame) };
    assert.equal(decodePayload(payload, outgoingContext).format, "binary");
    assert.deepEqual([...fromBase64(payload.data)], [...frame]);
  }
});
