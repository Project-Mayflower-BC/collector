(() => {
  "use strict";
  const BUS = "colonist-session-collector/v1";
  const documentId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  let configured = false;
  let enabled = true;
  let queue = [];
  let sending = false;
  let retries = 0;
  let nextRetryAt = 0;
  let queuedBytes = 0;
  let dropped = 0;
  let lastError = null;
  let inFlight = 0;
  let pendingPayloads = 0;
  let reportedDropped = 0;

  function control() {
    if (configured) window.postMessage({ source: BUS, type: "control", enabled }, location.origin);
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== BUS) return;
    if (event.data.type === "ready") { control(); return; }
    if (event.data.type === "capture-status") {
      if (Number.isSafeInteger(event.data.pendingPayloads) && event.data.pendingPayloads >= 0) {
        pendingPayloads = event.data.pendingPayloads;
      }
      return;
    }
    if (event.data.type !== "event" || !configured) return;
    const packet = event.data.event;
    if (!Number.isSafeInteger(packet?.sequence) || packet.sequence < 1) return;
    const size = (packet.payload?.data?.length || 0) + 1024;
    if (queue.length >= 2000 || queuedBytes + size > 32 * 1024 * 1024) { dropped++; return; }
    queue.push(packet);
    queuedBytes += size;
    if (queue.length >= 50) void flush();
  });

  async function flush() {
    if (sending || (!queue.length && dropped === reportedDropped) || Date.now() < nextRetryAt) return;
    sending = true;
    try {
      while (queue.length || dropped !== reportedDropped) {
        const batch = [];
        let bytes = 0;
        while (queue.length && batch.length < 50) {
          const size = (queue[0].payload?.data?.length || 0) + 1024;
          if (batch.length && bytes + size > 4 * 1024 * 1024) break;
          batch.push(queue.shift());
          bytes += size;
        }
        inFlight = batch.length || 1; // Include a diagnostics-only storage write.
        const batchDropped = dropped;
        try {
          const response = await chrome.runtime.sendMessage({ type: "capture-batch", documentId,
            startedAt, events: batch, dropped: batchDropped });
          if (!response?.ok) throw new Error(response?.error || "Storage did not acknowledge the batch.");
          queuedBytes -= bytes;
          reportedDropped = batchDropped;
          lastError = null;
          retries = 0;
        } catch (error) {
          lastError = String(error);
          queue.unshift(...batch);
          nextRetryAt = Date.now() + Math.min(30000, 250 * 2 ** Math.min(++retries, 7));
          break;
        } finally {
          inFlight = 0;
        }
      }
    } finally {
      sending = false;
    }
  }

  chrome.storage.local.get({ recordingEnabled: true }).then(settings => {
    enabled = settings.recordingEnabled;
    configured = true;
    control();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.recordingEnabled) return;
    enabled = changes.recordingEnabled.newValue === true;
    control();
    void flush();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message.type !== "bridge-status") return;
    respond({ documentId, queued: queue.length + inFlight, pendingPayloads, dropped, lastError, enabled });
  });
  // Short batches keep most data persisted even if the tab is abruptly closed.
  setInterval(() => { void flush(); }, 250);
  window.addEventListener("pagehide", () => { void flush(); });
})();
