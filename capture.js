(() => {
  "use strict";
  if (location.protocol !== "https:" ||
      !(location.hostname === "colonist.io" || location.hostname.endsWith(".colonist.io"))) return;
  const installed = Symbol.for("colonist-session-collector.installed");
  if (window[installed]) return;
  window[installed] = true;

  const BUS = "colonist-session-collector/v1";
  const MAX_BYTES = 16 * 1024 * 1024;
  const nativePost = window.postMessage.bind(window);
  let enabled = null;
  let sequence = 0;
  let socketCount = 0;
  let pending = [];
  let pendingBytes = 0;
  let droppedBeforeReady = 0;
  let processingPayloads = 0;

  function reportPending() {
    nativePost({ source: BUS, type: "capture-status", pendingPayloads: processingPayloads }, location.origin);
  }

  function trackPayload(event, promise, wasEnabled) {
    processingPayloads++;
    reportPending();
    void promise.then(payload => deliver({ ...event, payload }, wasEnabled), error =>
      deliver({ ...event, captureError: String(error) }, wasEnabled)).finally(() => {
        processingPayloads--;
        reportPending();
      });
  }

  function allowed(value) {
    try {
      const url = new URL(value, location.href);
      return ["https:", "wss:"].includes(url.protocol) &&
        (url.hostname === "colonist.io" || url.hostname.endsWith(".colonist.io"));
    } catch { return false; }
  }

  function cleanUrl(value) {
    const url = new URL(value, location.href);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|auth|password|secret|cookie|session|(^|[._-])sid($|[._-])/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.href;
  }

  function deliver(event, wasEnabled = enabled) {
    if (wasEnabled === false || (wasEnabled === null && enabled === false)) return;
    if (enabled === null) {
      const size = (event.payload?.data?.length || 0) + 1024;
      if (pending.length < 256 && pendingBytes + size <= 32 * 1024 * 1024) {
        pending.push(event);
        pendingBytes += size;
      } else droppedBeforeReady++;
      return;
    }
    nativePost({ source: BUS, type: "event", event }, location.origin);
  }

  // Reserve the sequence immediately: Blob/HTTP decoding can finish out of order.
  function reserve(metadata) {
    return { sequence: ++sequence, timestamp: new Date().toISOString(),
      monotonicMs: performance.now(), ...metadata };
  }

  function copyPayload(value) {
    if (typeof value === "string" || value instanceof Blob) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    }
    return String(value);
  }

  async function encode(value) {
    if (typeof value === "string") {
      const bytes = new TextEncoder().encode(value).length;
      return bytes > MAX_BYTES ? { encoding: "omitted", byteLength: bytes,
        reason: "Payload exceeds the 16 MiB capture limit." } :
        { encoding: "text", data: value, byteLength: bytes };
    }
    const bytes = value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value;
    if (bytes.byteLength > MAX_BYTES) return { encoding: "omitted", byteLength: bytes.byteLength,
      reason: "Payload exceeds the 16 MiB capture limit." };
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    }
    return { encoding: "base64", data: btoa(binary), byteLength: bytes.length };
  }

  function record(metadata, value) {
    if (enabled === false) return;
    const wasEnabled = enabled;
    const event = reserve(metadata);
    try {
      if (value === undefined) { deliver(event, wasEnabled); return; }
      const size = value instanceof Blob ? value.size : value?.byteLength;
      if (size > MAX_BYTES) {
        deliver({ ...event, payload: { encoding: "omitted", byteLength: size,
          reason: "Payload exceeds the 16 MiB capture limit." } }, wasEnabled);
        return;
      }
      const snapshot = copyPayload(value);
      trackPayload(event, encode(snapshot), wasEnabled);
    } catch (error) {
      deliver({ ...event, captureError: String(error) }, wasEnabled);
    }
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== BUS || event.data.type !== "control" ||
        typeof event.data.enabled !== "boolean") return;
    const previous = enabled;
    enabled = event.data.enabled;
    reportPending();
    const buffered = pending;
    pending = [];
    pendingBytes = 0;
    if (enabled) {
      for (const item of buffered) deliver(item);
      if (droppedBeforeReady) record({ transport: "collector", kind: "gap",
        dropped: droppedBeforeReady, reason: "Startup buffer filled before extension was ready." });
    }
    droppedBeforeReady = 0;
    if (previous !== null && previous !== enabled) {
      deliver(reserve({ transport: "collector", kind: enabled ? "resume" : "pause",
        reason: "Recording setting changed; events while paused are not captured." }), true);
    }
  });

  const NativeWebSocket = window.WebSocket;
  const sockets = new WeakMap();
  const nativeSend = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function (data) {
    // Native validation and errors retain their usual behavior.
    const result = Reflect.apply(nativeSend, this, arguments);
    const meta = sockets.get(this);
    if (meta) record({ ...meta, kind: "message", direction: "outgoing" }, data);
    return result;
  };
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      if (!allowed(socket.url)) return socket;
      const meta = { transport: "websocket", connectionId: `ws-${++socketCount}`,
        url: cleanUrl(socket.url) };
      sockets.set(socket, meta);
      record({ ...meta, kind: "connecting" });
      socket.addEventListener("open", () => record({ ...meta, kind: "open",
        protocol: socket.protocol }));
      socket.addEventListener("message", event =>
        record({ ...meta, kind: "message", direction: "incoming" }, event.data));
      socket.addEventListener("close", event => record({ ...meta, kind: "close",
        code: event.code, reason: event.reason, wasClean: event.wasClean }));
      socket.addEventListener("error", () => record({ ...meta, kind: "error" }));
      return socket;
    }
  });

  const relevantType = type => /json|msgpack|messagepack|octet-stream|text\/plain/i.test(type);
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const result = Reflect.apply(nativeFetch, this, arguments);
    // Observe a clone; never consume or change the response returned to the game.
    void result.then(response => {
      try {
        const requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        if (!allowed(requestUrl) || !allowed(response.url || requestUrl) ||
            !relevantType(response.headers.get("content-type") || "") || enabled === false) return;
        const metadata = { transport: "fetch", kind: "response", direction: "incoming",
          url: cleanUrl(response.url || requestUrl), method: init?.method || input?.method || "GET",
          status: response.status, contentType: response.headers.get("content-type") };
        const event = reserve(metadata);
        const wasEnabled = enabled;
        try {
          trackPayload(event, response.clone().arrayBuffer().then(buffer => encode(new Uint8Array(buffer))), wasEnabled);
        } catch (error) {
          deliver({ ...event, captureError: String(error) }, wasEnabled);
        }
      } catch { /* Observation must not affect the game's request. */ }
    }, () => {});
    return result;
  };

  const xhrMeta = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    const result = Reflect.apply(nativeOpen, this, arguments);
    xhrMeta.set(this, { method: String(method), url: String(url) });
    return result;
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    const meta = xhrMeta.get(xhr);
    const onLoad = () => {
      try {
        if (!meta || !allowed(meta.url) || !allowed(xhr.responseURL || meta.url) ||
            !relevantType(xhr.getResponseHeader("content-type") || "")) return;
        const value = xhr.responseType === "json" ? JSON.stringify(xhr.response) : xhr.response;
        record({ transport: "xhr", kind: "response", direction: "incoming",
          method: meta.method, url: cleanUrl(xhr.responseURL || meta.url), status: xhr.status,
          contentType: xhr.getResponseHeader("content-type") }, value);
      } catch { /* Ignore inaccessible or unsupported response types. */ }
    };
    const onEnd = () => xhr.removeEventListener("load", onLoad);
    xhr.addEventListener("load", onLoad, { once: true });
    xhr.addEventListener("loadend", onEnd, { once: true });
    try { return Reflect.apply(nativeXhrSend, xhr, arguments); }
    catch (error) {
      xhr.removeEventListener("load", onLoad);
      xhr.removeEventListener("loadend", onEnd);
      throw error;
    }
  };
  nativePost({ source: BUS, type: "ready" }, location.origin);
})();
