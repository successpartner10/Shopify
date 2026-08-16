const DB_NAME = "storescope";
const STORE = "sessions";
export const THREADS = "threads";   // chat threads, on-device only
export const OUTBOX = "outbox";     // messages typed while offline
const VERSION = 2;                  // v1 -> v2 adds the two chat stores

/** Shared opener: history and chat must agree on the version or IDB throws. */
export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("createdAt", "createdAt");
      }
      if (!db.objectStoreNames.contains(THREADS)) {
        const th = db.createObjectStore(THREADS, { keyPath: "id" });
        th.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        db.createObjectStore(OUTBOX, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(entry) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const rec = {
      createdAt: Date.now(),
      query: entry.query,
      title: entry.title,
      explanation: entry.explanation,
      steps: entry.steps,
      category: entry.category,
      source: entry.source,
      target: entry.target,
      confidence: entry.confidence
    };
    const req = tx.objectStore(STORE).add(rec);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listSessions(limit = 40) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).index("createdAt").openCursor(null, "prev");
    const out = [];
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push({ id: cursor.primaryKey, ...cursor.value });
        cursor.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearSessions() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
