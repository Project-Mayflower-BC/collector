import { isColonistUrl, safeUrl } from "./scope.js";
import { decodePayload } from "./decode.js";
import { classifyHttp, isHeartbeat, observeGame, resetGameStream, finishGame, newGameState } from "./filter.js";

export const PAYLOAD_LIMIT = 16 * 1024 * 1024;
const BODY_TYPES = /json|msgpack|octet-stream|text\/plain/i;
const MAX_REQUESTS = 2000;
const FRAME_EVENTS = ["Network.webSocketFrameSent", "Network.webSocketFrameReceived"];
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
    // Sockets rejected at creation; never adopted later as "unknown".
    this.ignoredSockets = new Map();
    this.requests = new Map();
    this.closed = false;
    this.epoch = 0;
  }
  diagnostic(kind, detail) { this.writer.emit({ transport: "collector", kind, detail }); }
  get game() { return this.writer.metadata.game ??= newGameState(); }
  gameWarnings(warnings) {
    for (const { code, message, ...rest } of warnings) {
      this.writer.emit({ transport: "collector", kind: "game-warning", code, detail: message,
        ...(rest.serverSequence !== undefined ? { serverSequence: rest.serverSequence } : {}) });
    }
  }
  // Checks game-channel continuity on stored incoming messages.
  watchGame(event) {
    const value = decodePayload(event.payload, event).value;
    if (String(value?.id) !== "130") return;
    this.gameWarnings(observeGame(this.game, value.data, { connectionId: event.connectionId }));
  }
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
    this.ignoredSockets.clear();
    this.gameWarnings(finishGame(this.game));
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
      this.ignoredSockets.clear();
      resetGameStream(this.game);
      this.diagnostic("navigation", safeUrl(p.frame.url));
      return;
    }
    if (method === "Network.requestWillBeSent") {
      if (p.type === "Document" && p.frameId === this.mainFrameId && !isColonistUrl(p.request.url, ["https:"])) {
        this.leave("Navigating outside Colonist."); return;
      }
      this.requests.delete(p.requestId);
      if (this.enabled && ["Fetch", "XHR"].includes(p.type) && isColonistUrl(p.request.url, ["https:"])) {
        const noise = classifyHttp(p.request.url);
        if (noise) { this.writer.skip(noise); return; }
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
      } else this.track(this.ignoredSockets, p.requestId, true);
      return;
    }
    let socket = this.sockets.get(p.requestId);
    // A socket created while the worker was stopped is first seen through its frames. The
    // attached tab is verified Colonist, but the endpoint URL is unknown, so mark it.
    if (!socket && FRAME_EVENTS.includes(method) && !this.ignoredSockets.has(p.requestId)) {
      socket = { url: null, connectionId: `ws-${p.requestId}`, unverified: true };
      this.track(this.sockets, p.requestId, socket);
      if (this.enabled) this.writer.emit({ ...socket, transport: "websocket", kind: "connect",
        detail: "Socket first seen mid-stream; the recorder missed its creation, so its URL is unknown." });
    }
    if (socket && method.startsWith("Network.webSocket")) {
      const event = { ...socket, transport: "websocket", cdpTimestamp: p.timestamp };
      if (this.enabled) {
        if (FRAME_EVENTS.includes(method)) {
          const { opcode, payloadData } = p.response;
          const message = { ...event, kind: opcode === 1 || opcode === 2 ? "message" : "control",
            direction: method.endsWith("Sent") ? "outgoing" : "incoming", opcode,
            payload: payload(payloadData, opcode !== 1) };
          if (isHeartbeat(message)) this.writer.skip("heartbeat", message.payload.byteLength, true);
          else {
            this.writer.emit(message);
            if (message.kind === "message" && message.direction === "incoming") this.watchGame(message);
          }
        } else if (method === "Network.webSocketHandshakeResponseReceived") {
          this.writer.emit({ ...event, kind: "open", status: p.response.status });
        } else if (method === "Network.webSocketFrameError") {
          this.writer.emit({ ...event, kind: "error", captureError: p.errorMessage });
        } else if (method === "Network.webSocketClosed") this.writer.emit({ ...event, kind: "close" });
      }
      if (method === "Network.webSocketClosed") this.sockets.delete(p.requestId);
      return;
    }
    if (method === "Network.webSocketClosed") {
      this.ignoredSockets.delete(p.requestId);
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
