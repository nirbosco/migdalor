// חותמטק: אחסון מקומי ב-IndexedDB.
// שני מחסנים: chunks (מקטעי הקלטה, נשמרים תוך כדי צילום) ו-state
// (מצב העלאה מתמשך, כדי שהעלאה שנקטעה תמשיך מאותה נקודה גם אחרי סגירת הדף).

const DB_NAME = "migdalor";
const DB_VERSION = 1;
const CHUNKS = "chunks";
const STATE = "state";

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHUNKS)) {
        db.createObjectStore(CHUNKS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STATE)) {
        db.createObjectStore(STATE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

// ---- מקטעי הקלטה ----

export async function putChunk(session, seq, blob, mime) {
  const db = await openDB();
  const id = `${session}-${String(seq).padStart(6, "0")}`;
  return tx(db, CHUNKS, "readwrite", (s) =>
    s.put({ id, session, seq, blob, mime, ts: Date.now() })
  );
}

export async function allChunks() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(CHUNKS).objectStore(CHUNKS).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => (a.id < b.id ? -1 : 1)));
    req.onerror = () => reject(req.error);
  });
}

export async function clearChunks() {
  const db = await openDB();
  return tx(db, CHUNKS, "readwrite", (s) => s.clear());
}

// ---- מצב העלאה ----
// רשומה אחת פעילה לכל היותר (המערכת מעלה שיעור אחד בכל רגע).

const UPLOAD_KEY = "upload";

export async function saveUploadState(state) {
  const db = await openDB();
  return tx(db, STATE, "readwrite", (s) => s.put({ key: UPLOAD_KEY, ...state }));
}

export async function getUploadState() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STATE).objectStore(STATE).get(UPLOAD_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearUploadState() {
  const db = await openDB();
  return tx(db, STATE, "readwrite", (s) => s.delete(UPLOAD_KEY));
}

// ---- שמירת הקובץ המורכב (לשחזור העלאה אחרי סגירת דף) ----
// אחרי הרכבת ההקלטה נשמר גם ה-blob המלא, כדי שהמשך העלאה לא יהיה תלוי
// במקטעים. לקובץ שנבחר מהגלריה (מסלול ב) לא שומרים עותק, כדי לא להכפיל
// אחסון בטלפונים מלאים; שם ההמשך הוא בחירה חוזרת של אותו קובץ.

const BLOB_KEY = "uploadBlob";

export async function saveUploadBlob(blob) {
  const db = await openDB();
  return tx(db, STATE, "readwrite", (s) => s.put({ key: BLOB_KEY, blob }));
}

export async function getUploadBlob() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STATE).objectStore(STATE).get(BLOB_KEY);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearUploadBlob() {
  const db = await openDB();
  return tx(db, STATE, "readwrite", (s) => s.delete(BLOB_KEY));
}

// ---- הערכת מקום פנוי, בדקות צילום ----

export async function estimateSpaceMinutes(videoBps) {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const free = quota - usage;
    const minutes = Math.floor((free / ((videoBps / 8) * 60)) * 0.8); // שולי ביטחון 20%
    return { free, minutes };
  } catch (e) {
    return null;
  }
}

export async function requestPersist() {
  try {
    await navigator.storage.persist();
  } catch (e) {
    /* לא זמין, לא קריטי */
  }
}
