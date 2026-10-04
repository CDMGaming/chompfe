// TAPE's SD card, the parts you changed: recordings saved to slots, copies,
// erased factory sounds, the tape. Kept in this browser (IndexedDB) so they
// are there next time. Factory sounds aren't stored (they come with the
// page); an erased one is stored as null. Every call fails soft.
const DB = 'chompfe-card';
const STORE = 'files';

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** -> Map(file name -> Uint8Array | null) */
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
        out.set(c.key, v instanceof Uint8Array ? v : null);
        c.continue();
      };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  } catch { /* storage blocked */ }
  return out;
}

/** Write changed files (Uint8Array) and erased ones (null). */
export async function putMany(entries) {
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      for (const [name, data] of entries) s.put(data, name);
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
    return true;
  } catch {
    return false;
  }
}

/** Forget everything (back to the factory card). */
export async function clear() {
  try {
    const db = await open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      t.objectStore(STORE).clear();
      t.oncomplete = () => { db.close(); resolve(); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
    return true;
  } catch {
    return false;
  }
}
