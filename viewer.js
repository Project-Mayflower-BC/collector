import { listSessions, readSession, deleteSession } from "./db.js";
import { decodePayload, makeExport } from "./decode.js";

const $ = selector => document.querySelector(selector);
const PAGE_SIZE = 200;
let recording = null;
let filtered = [];
let page = 0;
let selectedSequence;
let cache = new Map();
const inspect = event => {
  if (!cache.has(event.sequence)) {
    const decoded = decodePayload(event.payload, event);
    cache.set(event.sequence, !event.payload && event.detail ? { ...decoded, detail: event.detail } : decoded);
  }
  return cache.get(event.sequence);
};
const json = value => JSON.stringify(value, (_key, item) =>
  typeof item === "number" && !Number.isFinite(item) ? { $float: String(item) } : item, 2);

async function run(action) {
  $("#error").hidden = true;
  try { await action(); }
  catch (error) { $("#error").textContent = String(error); $("#error").hidden = false; }
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
    option.textContent = "No recordings yet — start from the extension popup on Colonist";
    option.value = "";
    $("#sessions").append(option);
  } else if (sessions.some(session => session.id === previousId)) $("#sessions").value = previousId;
  await loadRecording();
}

async function loadRecording() {
  const id = $("#sessions").value;
  recording = id ? await readSession(id) : null;
  cache = new Map();
  page = 0;
  selectedSequence = undefined;
  $("#export").disabled = !recording;
  $("#delete").disabled = !recording;
  $("#warning").hidden = true;
  $("#detail-title").textContent = "Select an event";
  $("#detail-meta").textContent = "Raw bytes are retained; decoding is best effort.";
  $("#decoded").textContent = "No event selected.";
  $("#raw").textContent = "";
  if (recording) {
    const counts = {};
    for (const event of recording.events) counts[event.transport] = (counts[event.transport] || 0) + 1;
    $("#summary").textContent = `${recording.events.length} events · ` +
      Object.entries(counts).map(([source, count]) => `${count} ${source}`).join(" · ");
    const problems = recording.events.filter(event => ["gap", "pause", "resume"].includes(event.kind) || event.captureError || event.payload?.encoding === "omitted");
    const dropped = (recording.session.bridgeDropped || 0) + (recording.session.captureDropped || 0);
    if (problems.length || dropped || recording.session.interrupted) {
      $("#warning").hidden = false;
      $("#warning").textContent = `${problems.length} capture warning(s); ${dropped} events dropped. ` +
        (recording.session.interrupted ? `Recording interrupted: ${recording.session.endReason}. ` : "") +
        "Inspect the trace before reconstructing a game.";
    }
  } else $("#summary").textContent = "No recorded sessions yet. Start before joining a game to capture the initial state.";
  filterEvents();
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
$("#export").addEventListener("click", () => { void run(async () => {
  const state = await chrome.runtime.sendMessage({ type: "recorder-status" });
  if (!state?.ok) throw new Error(state?.error || "Could not check recorder status.");
  if (state.sessionId === recording.session.id && (state.activeTabId !== null || state.queued || state.pendingBodies)) {
    throw new Error("Stop recording in the popup and wait for zero pending events before exporting this session.");
  }
  const latest = await readSession(recording.session.id);
  const url = URL.createObjectURL(new Blob([json(makeExport(latest))], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `colonist-${latest.session.startedAt.replace(/[:.]/g, "-")}-${latest.session.id.slice(0, 8)}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
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
