import { saveBatch, readCheckpoint, deleteSession } from "./db.js";
import { isColonistUrl, safeUrl } from "./scope.js";
import { EventWriter } from "./writer.js";
import { NetworkCapture, PAYLOAD_LIMIT } from "./network.js";
import { gameSummary, hasSnapshot } from "./filter.js";

const gameStatus = game => game ? { summary: gameSummary(game), messages: game.messages, missing: game.missing,
  snapshot: hasSnapshot(game), warningCount: game.warningCount, lastWarning: game.lastWarning } : null;

// Builds the JSON in an offscreen document: service workers cannot create blob URLs,
// and data URLs above ~2 MB fail to download.
export async function prepareExport(api, sessionId) {
  try {
    await api.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"],
      justification: "Build the recording's JSON file for download." });
  } catch (error) { if (!/single offscreen/i.test(String(error))) throw error; }
  const result = await api.runtime.sendMessage({ type: "offscreen-export", sessionId });
  if (!result?.ok) throw new Error(result?.error || "Could not prepare the JSON file.");
  return { url: result.url, filename: result.filename, release: async () => {
    await api.runtime.sendMessage({ type: "offscreen-revoke", url: result.url }).catch(() => {});
  } };
}

// Dependency injection lets restart/detach races be exercised without a live browser.
export class Recorder {
  constructor(api, { save = saveBatch, checkpoint = readCheckpoint, remove = deleteSession,
    prepare = sessionId => prepareExport(api, sessionId), wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
    interval = (callback, ms) => setInterval(callback, ms), cancelInterval = timer => clearInterval(timer) } = {}) {
    Object.assign(this, { api, save, checkpoint, remove, prepare, wait, interval, cancelInterval });
    this.initialized = false;
    this.early = [];
    this.saving = new Set();
    this.active = null;
    this.lastWriter = null;
    this.enabled = true;
    this.busy = false;
    this.notice = null;
    this.ledgerWrites = Promise.resolve();
    this.ready = this.initialize().catch(async error => {
      this.recoveryError = String(error);
      if (this.active) {
        const current = this.active;
        this.active = null;
        this.stopHealth();
        current.capture.diagnostic("gap", `Initialization failed: ${String(error)}`);
        current.capture.close(String(error), { interrupted: true, stopCode: "initialization_failed" });
      }
      if (this.prior?.tabId !== undefined) {
        try { await this.api.debugger.detach({ tabId: this.prior.tabId }); } catch { /* May already be gone. */ }
      }
      try { await this.setNotice(`Recorder initialization failed: ${String(error)}`, true); }
      catch { this.notice = { message: `Recorder initialization failed: ${String(error)}`, unexpected: true, at: new Date().toISOString() }; }
      await this.badge().catch(() => {});
    }).finally(() => this.replayEarly());
  }
  replayEarly() {
    this.initialized = true;
    const early = this.early;
    this.early = [];
    for (const [source, method, params] of early) this.handle(source, method, params);
  }
  ledger(operation) {
    const result = this.ledgerWrites.then(operation);
    this.ledgerWrites = result.catch(() => {});
    return result;
  }
  pending(writer = this.lastWriter) {
    return !!writer && !!(writer.status().queued || writer.pendingBodies || writer.running || writer.dirty);
  }
  async clearLedger() {
    await this.ledger(async () => {
      // Kept while saving, so a worker restart mid-save can finish the JSON export.
      if (!this.active && !this.pending() && !this.saving.size) await this.api.storage.session.remove("debuggerRecording");
    });
  }
  async badge() {
    const text = this.active ? (this.enabled ? "REC" : "PAUSE") : this.notice?.unexpected ? "ERR" : "OFF";
    await this.api.action.setBadgeText({ text });
    await this.api.action.setBadgeBackgroundColor({ color: text === "REC" ? "#06746d" : text === "ERR" ? "#ae2e37" : "#657080" });
    await this.api.action.setTitle({ title: this.active ? `Colonist Collector: ${this.enabled ? "recording" : "paused"}`
      : this.notice?.message || "Colonist Session Collector" });
  }
  async setNotice(message, unexpected = false, extra = {}) {
    this.notice = message ? { message, unexpected, at: new Date().toISOString(), ...extra } : null;
    const notice = this.notice;
    // Notices survive a service-worker restart and browser restart.
    await this.ledger(() => this.api.storage.local.set({ recorderNotice: notice }));
  }
  writer(metadata, sequence = 0) {
    const writer = new EventWriter(metadata, this.save, { changed: () => { void this.clearLedger().catch(() => {}); } });
    writer.sequence = sequence;
    this.lastWriter = writer;
    return writer;
  }
  attachState(metadata, writer, frameId, sockets = []) {
    const capture = new NetworkCapture(writer, (method, params) =>
      this.api.debugger.sendCommand({ tabId: metadata.tabId }, method, params),
    reason => { void this.stop(reason, { code: "out_of_scope" }).catch(error => this.report(error)); }, this.enabled);
    capture.mainFrameId = frameId;
    // Only restore verified Colonist socket endpoints from our persisted trace.
    capture.sockets = new Map(sockets.filter(([, socket]) => isColonistUrl(socket.url, ["wss:"])).slice(-2000));
    this.active = { tabId: metadata.tabId, capture, writer };
    return capture;
  }
  async initialize() {
    const settings = await this.api.storage.local.get({ recordingEnabled: true, recorderNotice: null });
    this.enabled = settings.recordingEnabled !== false;
    this.notice = settings.recorderNotice;
    const { debuggerRecording: prior } = await this.api.storage.session.get("debuggerRecording");
    this.prior = prior;
    if (prior) {
      const checkpoint = await this.checkpoint(prior.id);
      const metadata = { ...prior, ...checkpoint.session };
      if (metadata.endedAt) {
        try { await this.api.debugger.detach({ tabId: prior.tabId }); } catch { /* Session already ended. */ }
        // The worker stopped before the JSON was saved; finish that now.
        if (checkpoint.session) void this.archive(prior.id, null, metadata.endReason || "Recording stopped.", !!metadata.interrupted,
          { sessionId: prior.id, stopCode: metadata.stopCode, lastMessageAt: metadata.lastMessageAt });
        else await this.api.storage.session.remove("debuggerRecording");
      }
      else {
        const writer = this.writer(metadata, checkpoint.sequence);
        let frame;
        try {
          const target = (await this.api.debugger.getTargets()).find(item => item.tabId === prior.tabId && item.type === "page");
          if (!target || !isColonistUrl(target.url, ["https:"])) throw new Error("Original Colonist tab is unavailable or outside scope.");
          // sendCommand verifies that this extension still owns the attachment;
          // getTargets.attached alone cannot distinguish another debugger.
          ({ frameTree: { frame } } = await this.api.debugger.sendCommand({ tabId: prior.tabId }, "Page.getFrameTree"));
          if (!isColonistUrl(frame.url, ["https:"])) throw new Error("Original tab left Colonist.");
        } catch (error) {
          frame = undefined;
          writer.emit({ transport: "collector", kind: "gap", detail: "Recorder restarted and its debugger session could not be restored." });
          Object.assign(writer.metadata, { endedAt: new Date().toISOString(), stopCode: "worker_session_lost", endReason: String(error), interrupted: true });
          writer.emit({ transport: "collector", kind: "stop", detail: String(error) });
          try { await this.api.debugger.detach({ tabId: prior.tabId }); } catch { /* Only an attachment owned by this extension can be detached. */ }
          const extra = { sessionId: prior.id, stopCode: "worker_session_lost", lastMessageAt: metadata.lastMessageAt };
          const message = `Recording interrupted after a recorder restart: ${String(error)} Start again on Colonist, then refresh to continue.`;
          await this.setNotice(message, true, extra);
          void this.archive(prior.id, writer, message, true, extra);
        }
        if (frame) {
          const sameDocument = metadata.documentLoaderId && metadata.documentLoaderId === frame.loaderId;
          const capture = this.attachState(metadata, writer, frame.id, sameDocument ? checkpoint.sockets : []);
          // The last persisted activity bounds when the worker stopped.
          const lastSeen = [metadata.lastHealthAt, metadata.lastEventAt].filter(Boolean).sort().at(-1);
          const down = lastSeen ? ` Last activity before the restart: ${lastSeen} (${Math.round((Date.now() - Date.parse(lastSeen)) / 1000)} s earlier).` : "";
          writer.emit({ transport: "collector", kind: "gap", workerDownSince: lastSeen,
            detail: "Background worker restarted. Continued the existing debugger attachment; uncommitted events and HTTP bodies may be missing." + down +
            (sameDocument ? "" : " The page changed or its identity is unknown; sockets already open are picked up from their next message.") });
          try {
            await this.api.debugger.sendCommand({ tabId: prior.tabId }, "Page.enable");
            await this.api.debugger.sendCommand({ tabId: prior.tabId }, "Network.enable", {
              maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: PAYLOAD_LIMIT, maxPostDataSize: 0
            });
            if (this.active?.capture === capture) {
              await this.setNotice("Recording recovered after a background restart. The trace contains a gap marker.", false, { sessionId: prior.id });
              if (this.active?.capture === capture) this.startHealth();
            }
          } catch (error) {
            if (this.active?.capture === capture) await this.stop(`Could not restore Network capture: ${String(error)}`,
              { unexpected: true, code: "worker_recovery_failed" });
          }
        }
      }
    }
    await this.clearLedger();
    await this.badge();
  }
  async start(tabId) {
    if (this.recoveryError) throw new Error(this.recoveryError);
    if (this.active || this.pending()) throw new Error("Stop the current recording and wait for pending writes before starting another.");
    const target = (await this.api.debugger.getTargets()).find(item => item.tabId === tabId && item.type === "page");
    if (!target || !isColonistUrl(target.url, ["https:"])) throw new Error("Select an HTTPS Colonist tab first.");
    await this.api.debugger.attach({ tabId }, "1.3");
    let capture;
    try {
      await this.api.debugger.sendCommand({ tabId }, "Page.enable");
      const { frameTree: { frame } } = await this.api.debugger.sendCommand({ tabId }, "Page.getFrameTree");
      if (!isColonistUrl(frame.url, ["https:"])) throw new Error("Tab left Colonist before recording started.");
      const metadata = { id: crypto.randomUUID(), tabId, pageUrl: safeUrl(frame.url),
        startedAt: new Date().toISOString(), captureMode: "chrome-debugger", captureDropped: 0,
        documentLoaderId: frame.loaderId, frameId: frame.id };
      capture = this.attachState(metadata, this.writer(metadata), frame.id);
      await this.ledger(() => this.api.storage.session.set({ debuggerRecording: metadata }));
      if (this.active?.capture !== capture) throw new Error("Recording interrupted during attachment.");
      capture.diagnostic("start", "Attached using Chrome Network events. Earlier traffic is unavailable; refresh before joining a game.");
      if (!this.enabled) capture.diagnostic("pause", "Capture was paused when the debugger attached.");
      await this.api.debugger.sendCommand({ tabId }, "Network.enable", {
        maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: PAYLOAD_LIMIT, maxPostDataSize: 0
      });
      if (this.active?.capture !== capture) throw new Error("Recording interrupted during attachment.");
      await this.setNotice(null);
      if (this.active?.capture !== capture) throw new Error("Recording interrupted during attachment.");
      this.active.visible = true;
      try { this.active.windowId = (await this.api.tabs.get(tabId)).windowId; } catch { /* Tab-switch logging is best effort. */ }
      this.startHealth();
      await this.badge();
    } catch (error) {
      if (this.active?.capture === capture) await this.stop(`Attach failed: ${String(error)}`, { unexpected: true, code: "attach_failed" });
      else { try { await this.api.debugger.detach({ tabId }); } catch { /* Closed or failed attachment. */ } }
      throw error;
    }
  }
  async stop(reason = "Stopped by user.", { detached = false, unexpected = false, code = "user_stop", detachReason } = {}) {
    const previous = this.active;
    if (!previous) return;
    this.active = null;
    this.stopHealth();
    if (unexpected) previous.capture.diagnostic("gap", reason);
    previous.capture.close(reason, { interrupted: unexpected, stopCode: code, ...(detachReason ? { detachReason } : {}) });
    if (!detached) {
      try { await this.api.debugger.detach({ tabId: previous.tabId }); }
      catch (error) { reason += ` Detach reported: ${String(error)}`; }
    }
    const extra = { sessionId: previous.writer.metadata.id, stopCode: code, detachReason,
      lastMessageAt: previous.writer.metadata.lastMessageAt };
    await this.setNotice(`${reason} Saving JSON to Downloads…`, unexpected, extra);
    // Not awaited: Stop returns immediately and the popup shows progress from status().
    void this.archive(previous.writer.metadata.id, previous.writer, reason, unexpected, extra);
    await this.badge();
  }
  // Writes the recording to Downloads, then clears it from the extension's storage.
  async exportSession(sessionId) {
    if (this.active?.writer.metadata.id === sessionId) throw new Error("Stop recording before exporting this session.");
    const { url, filename, release } = await this.prepare(sessionId);
    try {
      const id = await this.api.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
      await this.downloaded(id);
    } finally { await release(); }
    await this.remove(sessionId);
    return filename;
  }
  downloaded(id) {
    return new Promise((resolve, reject) => {
      const done = finish => { this.api.downloads.onChanged.removeListener(listener); finish(); };
      const settle = (state, error) => {
        if (state === "complete") done(resolve);
        else if (state === "interrupted") done(() => reject(new Error(`Download interrupted (${error || "unknown reason"}).`)));
      };
      const listener = delta => { if (delta.id === id) settle(delta.state?.current, delta.error?.current); };
      this.api.downloads.onChanged.addListener(listener);
      this.api.downloads.search({ id }).then(([item]) => settle(item?.state, item?.error), () => {});
    });
  }
  async archive(sessionId, writer, reason, unexpected, extra) {
    if (this.saving.has(sessionId)) return;
    this.saving.add(sessionId);
    let message;
    try {
      for (let waited = 0; writer && this.pending(writer) && waited < 15000; waited += 50) await this.wait(50);
      message = `${reason} Saved ${await this.exportSession(sessionId)} to Downloads.`;
    } catch (error) {
      // Already exported and cleared by an earlier worker.
      if (/not found/i.test(String(error))) message = reason;
      else {
        message = `${reason} Could not save the JSON file (${String(error)}). The recording is still kept; open Recordings to export it.`;
        unexpected = true;
      }
    } finally { this.saving.delete(sessionId); }
    // A newer recording's notice takes precedence.
    if (!this.active && (!this.notice || this.notice.sessionId === sessionId)) await this.setNotice(message, unexpected, extra);
    await this.clearLedger();
    await this.badge();
  }
  handle(source, method, params) {
    if (!this.initialized) {
      // An event that wakes a stopped worker arrives before recovery finishes; replay it afterwards.
      if (this.early.length < 10000) this.early.push([source, method, params]);
      return;
    }
    if (source.sessionId || !this.active || source.tabId !== this.active.tabId) return;
    const capture = this.active.capture;
    void capture.handle(method, params).catch(error => capture.diagnostic("gap", `Event processing failed: ${String(error)}`));
  }
  detached(source, reason) {
    if (source.tabId !== this.active?.tabId) return;
    // Cancelling Chrome's debugging banner is a deliberate stop, not a failure.
    const stopped = reason === "canceled_by_user"
      ? this.stop("Recording stopped from Chrome's debugging banner.",
        { detached: true, code: "banner_cancel", detachReason: reason })
      : this.stop(`Recording stopped: Chrome ended the debugger session (${reason}). Start again to continue; traffic after this point is not captured.`,
        { detached: true, unexpected: true, code: "debugger_detached", detachReason: reason });
    void stopped.catch(error => this.report(error));
  }
  tabActivated({ tabId, windowId }) {
    const current = this.active;
    if (!current) return;
    if (tabId === current.tabId) {
      current.windowId = windowId;
      if (current.visible === false) current.capture.diagnostic("tab", "Colonist tab is active again.");
      current.visible = true;
    } else if (windowId === current.windowId && current.visible !== false) {
      current.visible = false;
      current.capture.diagnostic("tab", "Switched to another tab; Colonist is in the background.");
    }
  }
  changed(changes, area) {
    if (area !== "local" || !changes.recordingEnabled) return;
    this.enabled = changes.recordingEnabled.newValue !== false;
    this.active?.capture.setEnabled(this.enabled);
    void this.badge();
  }
  report(error) {
    this.notice = { message: `Recorder error: ${String(error)}`, unexpected: true, at: new Date().toISOString() };
    void this.badge();
  }
  startHealth() {
    this.stopHealth();
    this.healthTimer = this.interval(() => { void this.checkHealth(); }, 15000);
  }
  stopHealth() {
    if (this.healthTimer !== undefined) this.cancelInterval(this.healthTimer);
    this.healthTimer = undefined;
  }
  async checkHealth() {
    if (!this.active || this.probing) return;
    this.probing = true;
    const current = this.active;
    try {
      // Extension API calls reset the worker's idle timer.
      await this.api.runtime?.getPlatformInfo?.().catch(() => {});
      const { frameTree: { frame } } = await this.api.debugger.sendCommand({ tabId: current.tabId }, "Page.getFrameTree");
      if (this.active !== current) return;
      if (!isColonistUrl(frame.url, ["https:"])) await this.stop("Tab left Colonist.", { code: "out_of_scope" });
      else current.writer.updateMetadata({ lastHealthAt: new Date().toISOString() });
    } catch (error) {
      // A banner cancel can fail this probe just before Chrome's onDetach reports the real reason.
      for (let waited = 0; this.active === current && waited < 1000; waited += 50) await this.wait(50);
      if (this.active === current) await this.stop(`Debugger connection check failed: ${String(error)}`, { unexpected: true, code: "connection_lost" });
    } finally { this.probing = false; }
  }
  status() {
    return { ok: true, activeTabId: this.active?.tabId ?? null, enabled: this.enabled, busy: this.busy,
      recovering: !this.initialized, saving: this.saving.size > 0, eventCount: this.lastWriter?.sequence || 0,
      notice: this.notice?.message || "", noticeAt: this.notice?.at, interrupted: this.notice?.unexpected || false,
      lastMessageAt: this.lastWriter?.metadata.lastMessageAt || this.notice?.lastMessageAt,
      lastHealthAt: this.lastWriter?.metadata.lastHealthAt,
      webSocketMessageCount: this.lastWriter?.metadata.webSocketMessageCount || 0,
      game: gameStatus(this.lastWriter?.metadata.game), filtered: this.lastWriter?.metadata.filtered || {},
      ...(this.lastWriter?.status() || { sessionId: this.notice?.sessionId, queued: 0, pendingBodies: 0, dropped: 0 }) };
  }
  async request(message) {
    // Status answers immediately so the popup never waits on worker recovery.
    if (message.type === "recorder-status") return this.status();
    await this.ready;
    if (message.type === "recorder-export") {
      if (typeof message.sessionId !== "string") throw new Error("Invalid recording.");
      if (this.saving.has(message.sessionId)) throw new Error("This recording is already being saved.");
      if (this.lastWriter?.metadata.id === message.sessionId && this.pending()) throw new Error("Wait for pending events before exporting.");
      this.saving.add(message.sessionId);
      try { return { ...this.status(), filename: await this.exportSession(message.sessionId) }; }
      finally { this.saving.delete(message.sessionId); }
    }
    if (this.busy) throw new Error("Recorder operation is already in progress.");
    this.busy = true;
    try {
      if (message.type === "recorder-start") {
        if (!Number.isInteger(message.tabId)) throw new Error("Invalid tab.");
        await this.start(message.tabId);
      } else await this.stop();
    } finally { this.busy = false; }
    return this.status();
  }
}
