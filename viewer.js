import { listSessions, readSession, deleteSession } from "./db.js";
import { decodePayload, exportJson as json } from "./decode.js";
import { newGameState, observeGame, resetGameStream, finishGame, gameSummary } from "./filter.js";

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 200;
let recording = null;
let filtered = [];
let page = 0;
let selectedSequence;
let cache = new Map();
let live = false;
const inspect = event => {
  if (!cache.has(event.sequence)) {
    const decoded = decodePayload(event.payload, event);
    cache.set(event.sequence, !event.payload && event.detail ? { ...decoded, detail: event.detail } : decoded);
  }
  return cache.get(event.sequence);
};

async function run(action) {
  $("#error").hidden = true;
  try { await action(); }
  // Errors relayed from the background arrive already prefixed with "Error: ".
  catch (error) { $("#error").textContent = String(error).replace(/^(Error: )+/, "Error: "); $("#error").hidden = false; }
}

async function refreshSessions() {
  const previousId = $("#sessions").value;
  const sessions = await listSessions();
  $("#sessions").replaceChildren();
  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = `${new Date(session.startedAt).toLocaleString()} · ${session.eventCount} events · ${session.pageUrl}`;
    $("#sessions").append(option);
  }
  if (!sessions.length) {
    const option = document.createElement("option");
    option.textContent = "No unsaved recordings. Saved games are JSON files in Downloads; use Open JSON file.";
    option.value = "";
    $("#sessions").append(option);
  } else if (sessions.some(session => session.id === previousId)) $("#sessions").value = previousId;
  await loadRecording();
}

async function loadRecording(file = null) {
  const id = $("#sessions").value;
  recording = file || (id ? await readSession(id) : null);
  cache = new Map();
  page = 0;
  selectedSequence = undefined;
  // The recording in progress is stopped first; stopping saves it automatically.
  const state = recording && !file ? await chrome.runtime.sendMessage({ type: "recorder-status" }) : null;
  live = !!state && state.activeTabId !== null && state.sessionId === recording.session.id;
  $("#export").textContent = live ? "Stop & save" : "Save JSON & clear";
  // A JSON file opened from disk is read-only here.
  $("#export").disabled = !recording || !!file;
  $("#delete").disabled = !recording || !!file || live;
  $("#warning").hidden = true;
  $("#game-warnings").hidden = true;
  $("#detail-title").textContent = "Select an event";
  $("#detail-meta").textContent = "Raw bytes are retained; decoding is best effort.";
  $("#decoded").textContent = "No event selected.";
  $("#raw").textContent = "";
  if (recording) {
    const counts = {};
    for (const event of recording.events) counts[event.transport] = (counts[event.transport] || 0) + 1;
    const game = checkGame(recording);
    const skipped = Object.entries(recording.session.filtered || {}).map(([kind, { count }]) => `${count} ${kind}`);
    $("#summary").textContent = `${recording.events.length} events · ` +
      Object.entries(counts).map(([source, count]) => `${count} ${source}`).join(" · ") +
      ` · Game: ${gameSummary(game)}` + (skipped.length ? ` · Not stored: ${skipped.join(", ")}` : "");
    const problems = recording.events.filter(event => ["gap", "pause", "resume"].includes(event.kind) || event.unverified || event.captureError || event.payload?.encoding === "omitted");
    $("#game-warnings").hidden = !game.warningCount;
    $("#game-warnings").replaceChildren(...game.warnings.map(warning => {
      const item = document.createElement("li");
      item.textContent = `${warning.eventSequence ? `Event ${warning.eventSequence}: ` : ""}${warning.message}`;
      return item;
    }));
    const dropped = (recording.session.bridgeDropped || 0) + (recording.session.captureDropped || 0);
    const noSocketMessages = !recording.events.some(event => event.transport === "websocket" && event.kind === "message");
    if (problems.length || dropped || recording.session.interrupted || noSocketMessages) {
      $("#warning").hidden = false;
      $("#warning").textContent = `${problems.length} capture warning(s); ${dropped} events dropped. ` +
        (recording.session.interrupted ? `Recording interrupted: ${(recording.session.endReason || "").replace(/\.?$/, ". ")}` : "") +
        (noSocketMessages ? "No WebSocket messages captured; this recording may contain only analytics rather than gameplay. Start recording, then refresh Colonist before joining a game. " : "") +
        "Inspect the trace before reconstructing a game.";
    }
  } else $("#summary").textContent = "No recorded sessions yet. Start before joining a game to capture the initial state.";
  filterEvents();
}

// Recomputed from the trace so recordings made before the live check also get game warnings.
function checkGame(current) {
  const state = newGameState();
  for (const event of current.events) {
    if (event.kind === "navigation") resetGameStream(state);
    if (event.transport !== "websocket" || event.kind !== "message" || event.direction !== "incoming") continue;
    const value = inspect(event).value;
    if (String(value?.id) === "130") observeGame(state, value.data, { connectionId: event.connectionId, eventSequence: event.sequence });
  }
  if (current.session.endedAt) finishGame(state);
  return state;
}

function filterEvents() {
  const query = $("#search").value.toLowerCase().trim();
  filtered = (recording?.events || []).filter(event => !query ||
    `${event.sequence} ${event.transport} ${event.kind} ${event.direction || ""} ${event.url || ""} ${event.detail || ""} ${event.captureError || ""} ${json(inspect(event))}`.toLowerCase().includes(query));
  page = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  renderEvents();
}

function renderEvents() {
  $("#events").replaceChildren();
  for (const event of filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const row = document.createElement("tr");
    row.tabIndex = 0;
    row.classList.toggle("selected", event.sequence === selectedSequence);
    for (const value of [event.sequence, new Date(event.timestamp).toLocaleTimeString(),
      event.transport, `${event.direction || ""} ${event.kind}`, event.payload?.byteLength ?? "—"]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const select = () => {
      selectedSequence = event.sequence;
      $("#detail-title").textContent = `Event ${event.sequence} · ${event.kind}`;
      $("#detail-meta").textContent = `${event.url || "Collector diagnostic"} · ${inspect(event).format}`;
      $("#decoded").textContent = json(inspect(event));
      $("#raw").textContent = json(event);
      renderEvents();
    };
    row.addEventListener("click", select);
    row.addEventListener("keydown", key => { if (key.key === "Enter") select(); });
    $("#events").append(row);
  }
  $("#previous").disabled = page === 0;
  $("#next").disabled = (page + 1) * PAGE_SIZE >= filtered.length;
  $("#page").textContent = `${filtered.length} matching · Page ${page + 1} of ${Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))}`;
}

$("#sessions").addEventListener("change", () => { void run(loadRecording); });
$("#refresh").addEventListener("click", () => { void run(refreshSessions); });
$("#search").addEventListener("input", () => { page = 0; filterEvents(); });
$("#previous").addEventListener("click", () => { page--; renderEvents(); });
$("#next").addEventListener("click", () => { page++; renderEvents(); });
// The background saves the file to Downloads and then clears the local copy.
$("#export").addEventListener("click", () => { void run(async () => {
  $("#export").disabled = true;
  if (live) {
    const stopped = await chrome.runtime.sendMessage({ type: "recorder-stop" });
    if (!stopped?.ok) { $("#export").disabled = false; throw new Error(stopped?.error || "Could not stop recording."); }
    let state = stopped;
    for (let waited = 0; (state.saving || state.activeTabId !== null) && waited < 60000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      state = await chrome.runtime.sendMessage({ type: "recorder-status" });
    }
    await refreshSessions();
    $("#summary").textContent = state.notice;
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "recorder-export", sessionId: recording.session.id });
  if (!result?.ok) { $("#export").disabled = false; throw new Error(result?.error || "Could not export this recording."); }
  await refreshSessions();
  $("#summary").textContent = `Saved ${result.filename} to Downloads and cleared it from the extension.`;
}); });
$("#open-file").addEventListener("change", () => { void run(async () => {
  const [file] = $("#open-file").files;
  if (!file) return;
  const data = JSON.parse(await file.text());
  if (!data?.session || !Array.isArray(data.events)) throw new Error("Not a collector export.");
  await loadRecording({ session: data.session, events: data.events });
  $("#summary").textContent = `${file.name} · ` + $("#summary").textContent;
  $("#open-file").value = "";
}); });
$("#delete").addEventListener("click", () => { void run(async () => {
  const state = await chrome.runtime.sendMessage({ type: "recorder-status" });
  if (!state?.ok) throw new Error(state?.error || "Could not check recorder status.");
  if (state.sessionId === recording.session.id && (state.activeTabId !== null || state.queued || state.pendingBodies)) {
    throw new Error("Stop recording and wait for pending events before deleting this session.");
  }
  if (!confirm("Delete this local recording? Export it first if you want to keep it.")) return;
  await deleteSession(recording.session.id);
  await refreshSessions();
}); });
const settings = await chrome.storage.local.get({ recordingEnabled: true });
$("#enabled").checked = settings.recordingEnabled;
$("#enabled").addEventListener("change", () => { void run(() =>
  chrome.storage.local.set({ recordingEnabled: $("#enabled").checked })); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.recordingEnabled) $("#enabled").checked = changes.recordingEnabled.newValue;
});
await run(refreshSessions);
