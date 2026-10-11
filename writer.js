// A bounded, idempotent queue. Pending includes writes not yet acknowledged by IDB.
export class EventWriter {
  constructor(metadata, save, { maxEvents = 2000, maxBytes = 32 * 1024 * 1024,
    schedule = (callback, ms) => setTimeout(callback, ms), changed = () => {} } = {}) {
    this.metadata = { ...metadata, captureDropped: metadata.captureDropped || 0 };
    Object.assign(this, { save, maxEvents, maxBytes, schedule, changed });
    this.sequence = 0;
    this.queue = [];
    this.bytes = 0;
    this.inFlight = 0;
    this.pendingBodies = 0;
    this.lastError = null;
    this.running = false;
    this.dirty = false;
    this.retryMs = 250;
  }
  reserve(fields) {
    const timestamp = new Date().toISOString();
    this.metadata.lastEventAt = timestamp;
    if (["message", "response"].includes(fields.kind)) this.metadata.lastMessageAt = timestamp;
    return { ...fields, sequence: ++this.sequence, timestamp };
  }
  updateMetadata(fields) {
    Object.assign(this.metadata, fields);
    this.dirty = true;
    void this.pump();
  }
  emit(fields) { this.enqueue(this.reserve(fields)); }
  enqueue(event) {
    const size = JSON.stringify(event).length * 2;
    if (this.queue.length + this.inFlight >= this.maxEvents || this.bytes + size > this.maxBytes) {
      this.metadata.captureDropped++;
    } else {
      this.queue.push({ event, size });
      this.bytes += size;
    }
    this.dirty = true;
    void this.pump();
  }
  status() {
    return { sessionId: this.metadata.id, queued: this.queue.length + this.inFlight,
      pendingBodies: this.pendingBodies, dropped: this.metadata.captureDropped, lastError: this.lastError };
  }
  async pump() {
    if (this.running || (!this.queue.length && !this.dirty)) return;
    this.running = true;
    const batch = this.queue.splice(0, 50);
    this.inFlight = batch.length || 1;
    this.dirty = false;
    try {
      await this.save({ ...this.metadata }, batch.map(item => item.event));
      this.bytes -= batch.reduce((total, item) => total + item.size, 0);
      this.inFlight = 0;
      this.lastError = null;
      this.retryMs = 250;
      this.running = false;
      this.changed();
      void this.pump();
    } catch (error) {
      this.queue.unshift(...batch);
      this.inFlight = 0;
      this.dirty = true;
      this.lastError = String(error);
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, 30000);
      this.changed();
      this.schedule(() => { this.running = false; void this.pump(); }, delay);
    }
  }
}
