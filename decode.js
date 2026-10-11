import { isColonistUrl } from "./scope.js";

// Best-effort decoding only. Exports always retain the original text/base64 bytes.
export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

export function fromBase64(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export function decodeMessagePack(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let offset = 0;
  let items = 0;
  function ensure(length) {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > bytes.length) {
      throw new Error("Truncated MessagePack value.");
    }
  }
  function number(method, size) {
    ensure(size);
    const value = view[method](offset, false);
    offset += size;
    return value;
  }
  function take(length) {
    ensure(length);
    const value = bytes.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  const string = length => utf8.decode(take(length));
  const binary = length => ({ $binary: toBase64(take(length)), byteLength: length });
  function integer64(signed) {
    const value = number(signed ? "getBigInt64" : "getBigUint64", 8);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ?
      Number(value) : { $integer64: value.toString() };
  }
  function float(method, size) {
    const value = number(method, size);
    return Number.isFinite(value) ? value : { $float: String(value) };
  }
  function array(length, depth) {
    // Each element requires at least one byte; reject absurd lengths before allocation.
    ensure(length);
    return Array.from({ length }, () => read(depth + 1));
  }
  function map(length, depth) {
    ensure(length * 2);
    const entries = [];
    let stringKeys = true;
    for (let i = 0; i < length; i++) {
      const key = read(depth + 1);
      const value = read(depth + 1);
      if (typeof key !== "string") stringKeys = false;
      entries.push([key, value]);
    }
    // Preserve non-string keys without coercion or prototype mutation.
    return stringKeys ? Object.fromEntries(entries) : { $map: entries };
  }
  function extension(length) {
    const type = number("getInt8", 1);
    return { $extension: type, ...binary(length) };
  }
  function read(depth = 0) {
    if (depth > 128 || ++items > 1000000) throw new Error("MessagePack inspection limit exceeded.");
    const tag = number("getUint8", 1);
    if (tag <= 0x7f) return tag;
    if (tag >= 0xe0) return tag - 256;
    if ((tag & 0xe0) === 0xa0) return string(tag & 0x1f);
    if ((tag & 0xf0) === 0x90) return array(tag & 0xf, depth);
    if ((tag & 0xf0) === 0x80) return map(tag & 0xf, depth);
    switch (tag) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return binary(number("getUint8", 1));
      case 0xc5: return binary(number("getUint16", 2));
      case 0xc6: return binary(number("getUint32", 4));
      case 0xc7: return extension(number("getUint8", 1));
      case 0xc8: return extension(number("getUint16", 2));
      case 0xc9: return extension(number("getUint32", 4));
      case 0xca: return float("getFloat32", 4);
      case 0xcb: return float("getFloat64", 8);
      case 0xcc: return number("getUint8", 1);
      case 0xcd: return number("getUint16", 2);
      case 0xce: return number("getUint32", 4);
      case 0xcf: return integer64(false);
      case 0xd0: return number("getInt8", 1);
      case 0xd1: return number("getInt16", 2);
      case 0xd2: return number("getInt32", 4);
      case 0xd3: return integer64(true);
      case 0xd4: return extension(1);
      case 0xd5: return extension(2);
      case 0xd6: return extension(4);
      case 0xd7: return extension(8);
      case 0xd8: return extension(16);
      case 0xd9: return string(number("getUint8", 1));
      case 0xda: return string(number("getUint16", 2));
      case 0xdb: return string(number("getUint32", 4));
      case 0xdc: return array(number("getUint16", 2), depth);
      case 0xdd: return array(number("getUint32", 4), depth);
      case 0xde: return map(number("getUint16", 2), depth);
      case 0xdf: return map(number("getUint32", 4), depth);
      default: throw new Error(`Unsupported MessagePack tag 0x${tag.toString(16)}.`);
    }
  }
  const value = read();
  if (offset !== bytes.length) throw new Error("Trailing bytes after MessagePack value.");
  return value;
}

// Observed in a four-player recording: three header bytes, a route string,
// then one MessagePack body. Keep header bytes literal until their meaning
// is verified. Only accept the frame families actually observed so far.
export function decodeColonistClientFrame(bytes) {
  if (bytes.length < 4) throw new Error("Truncated Colonist client frame.");
  const [family, code, routeLength] = bytes;
  const known = (family === 2 && [2, 10, 11, 12].includes(code)) ||
    (family === 3 && code === 1) || (family === 4 && code === 8);
  if (!known || 3 + routeLength >= bytes.length) throw new Error("Unrecognized Colonist client header.");
  const route = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3, 3 + routeLength));
  if ((family === 2 && route !== "lobby") ||
      (family === 3 && !/^[a-z0-9]{1,32}$/i.test(route)) ||
      (family === 4 && route !== "")) throw new Error("Unrecognized Colonist client route.");
  const value = decodeMessagePack(bytes.subarray(3 + routeLength));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unrecognized Colonist client body.");
  }
  if (family === 3 && (!Number.isSafeInteger(value.action) || !Number.isSafeInteger(value.sequence))) {
    throw new Error("Unrecognized Colonist game action.");
  }
  if (family === 4 && String(value.id) !== "136") throw new Error("Unrecognized Colonist heartbeat.");
  return { format: "colonist-client-msgpack", headerBytes: [family, code, routeLength], route, value };
}

export function decodePayload(payload, event = {}) {
  if (!payload) return { format: "metadata" };
  if (payload.encoding === "omitted") return { format: "omitted", reason: payload.reason };
  if (payload.encoding === "text") {
    try { return { format: "json", value: JSON.parse(payload.data) }; }
    catch { return { format: "text", value: payload.data }; }
  }
  try {
    const bytes = fromBase64(payload.data);
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      try { return { format: "json", value: JSON.parse(text) }; } catch { /* Try MessagePack next. */ }
    } catch { /* Binary MessagePack need not be UTF-8. */ }
    try { return { format: "msgpack", value: decodeMessagePack(bytes) }; }
    catch (error) {
      if (event.transport === "websocket" && event.direction === "outgoing" && isColonistUrl(event.url)) {
        try { return decodeColonistClientFrame(bytes); } catch { /* Retain unknown frames as binary. */ }
      }
      return { format: "binary", byteLength: bytes.length, decodeError: error.message };
    }
  } catch (error) {
    return { format: "unknown", decodeError: error.message };
  }
}

export function makeExport(recording) {
  return {
    schema: "colonist-session-collector/v1",
    extensionVersion: "0.1.3",
    exportedAt: new Date().toISOString(),
    session: recording.session,
    events: [...recording.events].sort((a, b) => a.sequence - b.sequence).map(event =>
      ({ ...event, decoded: decodePayload(event.payload, event) }))
  };
}
