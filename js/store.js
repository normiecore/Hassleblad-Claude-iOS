/**
 * Camera roll persisted in IndexedDB so captures survive until they are shared to Photos.
 */
const DB_NAME = 'hcs-cam';
const STORE = 'photos';
const VERSION = 1;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** @param {{blob: Blob, width: number, height: number, lens: string, look: string, name: string}} photo */
export async function addPhoto(photo) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record = { id, ts: Date.now(), ...photo };
  await tx('readwrite', (s) => s.add(record));
  return record;
}

export async function listPhotos() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('ts').openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { out.push(cursor.value); cursor.continue(); } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getPhoto(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function deletePhoto(id) {
  await tx('readwrite', (s) => s.delete(id));
}

export async function countPhotos() {
  return tx('readonly', (s) => s.count());
}
