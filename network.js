import { isColonistUrl, safeUrl } from "./scope.js";

export const PAYLOAD_LIMIT = 16 * 1024 * 1024;
const BODY_TYPES = /json|msgpack|octet-stream|text\/plain/i;
const MAX_REQUESTS = 2000;
function payload(data, binary) {
  const byteLength = binary ? Math.floor(data.length * 3 / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
    : new TextEncoder().encode(data).byteLength;
  return byteLength > PAYLOAD_LIMIT ? { encoding: "omitted", byteLength, reason: "Payload exceeds 16 MiB." }
    : { encoding: binary ? "base64" : "text", data, byteLength };
}

// Consumes CDP Network events only; no code is installed or evaluated in the page.
export class NetworkCapture {
  constructor(writer, command, leave, enabled = true) {
    Object.assign(this, { writer, command, leave, enabled });
    this.sockets = new Map();
    this.requests = new Map();
    this.closed = false;
    this.epoch = 0;
  }
  diagnostic(kind, detail) { this.writer.emit({ transport: "collector", kind, detail }); }
  setEnabled(enabled) {
    if (enabled === this.enabled || this.closed) return;
    this.enabled = enabled;
    this.epoch++;
    this.requests.clear();
    this.diagnostic(enabled ? "resume" : "pause", "Capture setting changed; this trace may have gaps.");
  }
  close(reason, fields = {}) {
    if (this.closed) return;
    this.closed = true;
    this.requests.clear();
    this.sockets.clear();
    Object.assign(this.writer.metadata, fields, { endedAt: new Date().toISOString(), endReason: reason });
    this.diagnostic("stop", reason);
  }
  track(map, key, value) {
    if (!map.has(key) && map.size >= MAX_REQUESTS) {
      map.delete(map.keys().next().value);
      if (this.enabled) this.diagnostic("gap", "Request tracking capacity exceeded; one connection/request was evicted.");
    }
    map.set(key, value);
  }
  async handle(method, p) {
    if (this.closed) return;
    if (method === "Page.frameNavigated" && !p.frame.parentId) {
      if (!isColonistUrl(p.frame.url, ["https:"])) { this.leave("Navigated outside Colonist."); return; }
      this.mainFrameId = p.frame.id;
      Object.assign(this.writer.metadata, { documentLoaderId: p.frame.loaderId, frameId: p.frame.id });
      this.epoch++;
      this.requests.clear();
      this.sockets.clear();
      this.diagnostic("navigation", safeUrl(p.frame.url));
      return;
    }
    if (method === "Network.requestWillBeSent") {
      if (p.type === "Document" && p.frameId === this.mainFrameId && !isColonistUrl(p.request.url, ["https:"])) {
        this.leave("Navigating outside Colonist."); return;
      }
      this.requests.delete(p.requestId);
      if (this.enabled && ["Fetch", "XHR"].includes(p.type) && isColonistUrl(p.request.url, ["https:"])) {
        this.track(this.requests, p.requestId, { url: safeUrl(p.request.url), method: p.request.method,
          transport: p.type === "Fetch" ? "fetch" : "xhr" });
      }
      return;
    }
    if (method === "Network.webSocketCreated") {
      if (isColonistUrl(p.url, ["wss:"])) {
        const socket = { url: safeUrl(p.url), connectionId: `ws-${p.requestId}` };
        this.track(this.sockets, p.requestId, socket);
        if (this.enabled) this.writer.emit({ ...socket, transport: "websocket", kind: "connect" });
      }
      return;
    }
    const socket = this.sockets.get(p.requestId);
    if (socket && method.startsWith("Network.webSocket")) {
      const event = { ...socket, transport: "websocket", cdpTimestamp: p.timestamp };
      if (this.enabled) {
        if (["Network.webSocketFrameSent", "Network.webSocketFrameReceived"].includes(method)) {
          const { opcode, payloadData } = p.response;
          this.writer.emit({ ...event, kind: opcode === 1 || opcode === 2 ? "message" : "control",
            direction: method.endsWith("Sent") ? "outgoing" : "incoming", opcode,
            payload: payload(payloadData, opcode !== 1) });
        } else if (method === "Network.webSocketHandshakeResponseReceived") {
          this.writer.emit({ ...event, kind: "open", status: p.response.status });
        } else if (method === "Network.webSocketFrameError") {
          this.writer.emit({ ...event, kind: "error", captureError: p.errorMessage });
        } else if (method === "Network.webSocketClosed") this.writer.emit({ ...event, kind: "close" });
      }
      if (method === "Network.webSocketClosed") this.sockets.delete(p.requestId);
      return;
    }
    const request = this.requests.get(p.requestId);
    if (!request || !this.enabled) return;
    if (method === "Network.responseReceived") {
      if (!isColonistUrl(p.response.url, ["https:"]) || !BODY_TYPES.test(p.response.mimeType)) {
        this.requests.delete(p.requestId); return;
      }
      Object.assign(request, { url: safeUrl(p.response.url), status: p.response.status, contentType: p.response.mimeType, response: true });
    } else if (method === "Network.loadingFailed") {
      this.requests.delete(p.requestId);
      this.writer.emit({ ...request, response: undefined, kind: "error", captureError: p.errorText });
    } else if (method === "Network.loadingFinished") {
      this.requests.delete(p.requestId);
      if (!request.response) return;
      const event = this.writer.reserve({ ...request, response: undefined, kind: "response", direction: "incoming", cdpTimestamp: p.timestamp });
      if (p.encodedDataLength > PAYLOAD_LIMIT || this.writer.pendingBodies >= 8) {
        this.writer.enqueue({ ...event, payload: { encoding: "omitted", reason: "HTTP body size or concurrent retrieval limit exceeded." } });
        return;
      }
      this.writer.pendingBodies++;
      const epoch = this.epoch;
      try {
        const body = await this.command("Network.getResponseBody", { requestId: p.requestId });
        if (this.closed || epoch !== this.epoch) {
          this.writer.enqueue({ ...event, captureError: "HTTP retrieval crossed a stop, pause or navigation boundary; body omitted." });
        } else this.writer.enqueue({ ...event, payload: payload(body.body, body.base64Encoded) });
      } catch (error) {
        this.writer.enqueue({ ...event, captureError: `HTTP response unavailable: ${String(error)}` });
      } finally {
        this.writer.pendingBodies--;
        this.writer.changed();
      }
    }
  }
}
