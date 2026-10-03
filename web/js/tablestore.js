// Custom wavetables, kept in this browser (IndexedDB; a table is ~270 KB,
// too big for localStorage). Every call fails soft: if storage is blocked,
// tables still work for the session, they just aren't remembered.
const DB = 'chompfe';
const STORE = 'tables';

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(result && 'result' in result ? result.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/** -> Map(slot -> { name, data: Float32Array }) */
export async function loadAll() {
  const out = new Map();
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { db.close(); resolve(); return; }
        const v = c.value;
        if (v && v.data instanceof Float32Array) out.set(c.key, v);
        c.continue();
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch { /* storage blocked */ }
  return out;
}

export async function put(slot, name, data) {
  try { await tx('readwrite', (s) => s.put({ name, data }, slot)); return true; } catch { return false; }
}

export async function remove(slot) {
  try { await tx('readwrite', (s) => s.delete(slot)); return true; } catch { return false; }
}
