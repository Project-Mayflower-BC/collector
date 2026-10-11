const DB_NAME = "colonist-session-collector";
let opening;

export function openDb() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore("sessions", { keyPath: "id" });
      const events = db.createObjectStore("events", { keyPath: ["sessionId", "sequence"] });
      events.createIndex("sessionId", "sessionId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = undefined; reject(request.error); };
  });
  return opening;
}

const resultOf = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const completed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error || new Error("Storage transaction aborted."));
});

export async function saveBatch(metadata, events) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "events"], "readwrite");
  const done = completed(tx);
  const sessionStore = tx.objectStore("sessions");
  const eventStore = tx.objectStore("events");
  const request = sessionStore.get(metadata.id);
  request.onsuccess = () => {
    const previous = request.result;
    for (const event of events) eventStore.put({ ...event, sessionId: metadata.id });
    const count = eventStore.index("sessionId").count(metadata.id);
    count.onsuccess = () => sessionStore.put({ ...previous, ...metadata,
      startedAt: previous?.startedAt || metadata.startedAt,
      updatedAt: new Date().toISOString(), eventCount: count.result });
  };
  await done;
}

export async function listSessions() {
  const db = await openDb();
  const sessions = await resultOf(db.transaction("sessions").objectStore("sessions").getAll());
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readSession(id) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "events"]);
  const [session, events] = await Promise.all([
    resultOf(tx.objectStore("sessions").get(id)),
    resultOf(tx.objectStore("events").index("sessionId").getAll(id))
  ]);
  if (!session) throw new Error("Recording not found.");
  return { session, events };
}

// Read a small recovery checkpoint without loading every captured body into memory.
export async function readCheckpoint(id) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "events"]);
  const done = completed(tx);
  const sessionRequest = tx.objectStore("sessions").get(id);
  const sessionResult = resultOf(sessionRequest);
  const sockets = new Map();
  let sequence = 0;
  const request = tx.objectStore("events").index("sessionId").openCursor(id);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    const event = cursor.value;
    sequence = Math.max(sequence, event.sequence);
    if (event.kind === "navigation") sockets.clear();
    if (event.transport === "websocket" && event.kind === "connect") {
      sockets.set(event.connectionId.slice(3), { url: event.url, connectionId: event.connectionId });
      if (sockets.size > 2000) sockets.delete(sockets.keys().next().value);
    }
    if (event.transport === "websocket" && event.kind === "close") sockets.delete(event.connectionId.slice(3));
    cursor.continue();
  };
  const session = await sessionResult;
  await done;
  return { session, sequence, sockets: [...sockets] };
}

export async function deleteSession(id) {
  const db = await openDb();
  const tx = db.transaction(["sessions", "events"], "readwrite");
  const done = completed(tx);
  tx.objectStore("sessions").delete(id);
  const request = tx.objectStore("events").index("sessionId").openKeyCursor(id);
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    tx.objectStore("events").delete(cursor.primaryKey);
    cursor.continue();
  };
  await done;
}
