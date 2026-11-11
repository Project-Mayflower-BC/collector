import { decodeColonistClientFrame, decodeMessagePack, fromBase64 } from "./decode.js";

// Traffic that carries no game, player or account information. Dropped before storage;
// counts (and WebSocket byte totals) are kept in session metadata as `filtered`.
// Profile, friend, ranked, replay and user-state endpoints are deliberately kept.
export function classifyHttp(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return null; }
  if (path === "/api/analytic-events") return "analytics";
  // Sprite sheets, translation strings and Cloudflare challenge scripts: identical across games.
  if (path.startsWith("/dist/") || path.startsWith("/cdn-cgi/")) return "static";
  return null;
}

// Heartbeats are { id: "136", data: { timestamp } } in both directions, about 1 per second each.
// Matching is exact so a protocol change surfaces as stored messages, not silent loss.
export function isHeartbeat(event) {
  const { payload } = event;
  if (event.kind !== "message" || payload?.encoding !== "base64" || payload.byteLength > 64) return false;
  try {
    const bytes = fromBase64(payload.data);
    const value = event.direction === "outgoing" ? decodeColonistClientFrame(bytes).value : decodeMessagePack(bytes);
    return String(value?.id) === "136" && value.data && Object.keys(value.data).join() === "timestamp";
  } catch { return false; }
}

// Game-channel (id "130") continuity. Observed in every complete recording: server sequence
// starts at 1, the reset (type 1) is at 2, the board snapshot (type 4) at 3–4, and numbering
// then has no gaps through the result (type 45).
export const SNAPSHOT_TYPE = 4;
export const RESULT_TYPE = 45;
const DIFF_TYPE = 91;
// Small notices (types 6, 1, 59) can precede the snapshot; a state diff cannot be applied without it.
const SNAPSHOT_GRACE = 10;
const MAX_WARNINGS = 50;

export function newGameState() {
  return { messages: 0, snapshots: 0, results: 0, missing: 0, gaps: 0, warningCount: 0, warnings: [],
    stream: null };
}

function warn(state, code, message, extra = {}) {
  const warning = { code, message, at: new Date().toISOString(), ...extra };
  state.warningCount++;
  state.lastWarning = warning;
  if (state.warnings.length < MAX_WARNINGS) state.warnings.push(warning);
  return warning;
}

// A navigation or new socket starts a fresh stream; the server resends state on reload.
export function resetGameStream(state) { state.stream = null; }

// Returns any new warnings. `data` is the decoded `{ type, payload, sequence }` of an id-130 message.
export function observeGame(state, data, { connectionId = null, eventSequence } = {}) {
  const sequence = data?.sequence;
  const type = data?.type;
  if (typeof sequence !== "number") return [];
  const out = [];
  const extra = { eventSequence, serverSequence: sequence };
  let stream = state.stream;
  if (!stream || stream.connectionId !== connectionId || sequence <= stream.last) {
    stream = state.stream = { connectionId, first: sequence, last: null, count: 0, snapshot: false, result: false, warnedSnapshot: false };
  }
  state.messages++;
  stream.count++;
  if (stream.last === null) {
    if (sequence > 1 && type !== SNAPSHOT_TYPE) {
      out.push(warn(state, "late_start", `Game channel first seen at server message ${sequence}; messages 1–${sequence - 1} were missed.`, extra));
    }
  } else if (sequence > stream.last + 1) {
    const count = sequence - stream.last - 1;
    state.missing += count;
    state.gaps++;
    out.push(warn(state, "sequence_gap", `${count} game message(s) missing (server messages ${stream.last + 1}–${sequence - 1}).`,
      { ...extra, missingFrom: stream.last + 1, missingTo: sequence - 1 }));
  }
  if (type === SNAPSHOT_TYPE) { stream.snapshot = true; state.snapshots++; }
  else if (type === RESULT_TYPE) { stream.result = true; state.results++; }
  if (!stream.snapshot && !stream.warnedSnapshot && (type === DIFF_TYPE || stream.count >= SNAPSHOT_GRACE)) {
    stream.warnedSnapshot = true;
    out.push(warn(state, "missing_snapshot",
      "No board snapshot for this game. Refresh Colonist to request a fresh one; until then the board must be inferred.", extra));
  }
  stream.last = sequence;
  return out;
}

// Called when a recording stops. A game that started but has no result is flagged.
export function finishGame(state) {
  const stream = state.stream;
  if (!stream || stream.result || state.messages === 0) return [];
  return [warn(state, "no_result", "Recording stopped before this game's result arrived.", { serverSequence: stream.last })];
}

// After a navigation (for example back to the lobby) the last game is still described until a new one starts.
export const hasSnapshot = state => state.stream ? state.stream.snapshot : state.snapshots > 0;

export function gameSummary(state) {
  if (!state?.messages) return "No game messages yet.";
  return [`${state.messages} game messages`,
    hasSnapshot(state) ? "board snapshot ✓" : "no board snapshot",
    state.missing ? `${state.missing} missing` : "no gaps",
    state.results ? "result ✓" : null].filter(Boolean).join(" · ");
}
