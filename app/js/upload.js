// המגדלור: מנהל ההעלאה. multipart ל-R2 דרך ה-Worker, עם המשכה אוטומטית
// אחרי כל ניתוק: המצב (מפתח, מזהה העלאה, אילו חלקים כבר עלו) נשמר
// ב-IndexedDB, וההעלאה ממשיכה מאותה נקודה גם אחרי סגירת הדף.
// ההתקדמות מדווחת בדקות, לא באחוזים.

import { WORKER_URL, PART_SIZE, DEV } from "./config.js";
import { getAccessToken } from "./supa.js";
import {
  saveUploadState,
  getUploadState,
  clearUploadState,
  saveUploadBlob,
  getUploadBlob,
  clearUploadBlob,
  clearChunks,
} from "./store.js";

export { getUploadState, clearUploadState };

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60000;
const STALL_MS = 30000;

async function api(path, { method = "POST", body, headers = {} } = {}) {
  const token = await getAccessToken();
  const res = await fetch(WORKER_URL + path, {
    method,
    headers: {
      authorization: "Bearer " + token,
      ...(body && !(body instanceof Blob)
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
    },
    body: body && !(body instanceof Blob) ? JSON.stringify(body) : body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`worker ${path} ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// העלאת חלק אחד עם XHR (בשביל progress) והחזרת etag.
function putPart({ url, blob, authToken, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("authorization", "Bearer " + authToken);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch (e) {
          reject(new Error("bad part response"));
        }
      } else {
        const err = new Error("part upload failed: " + xhr.status);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(blob);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForOnline() {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((r) =>
    window.addEventListener("online", r, { once: true })
  );
}

// מנהל העלאה יחיד. callbacks:
//   onProgress({doneMinutes, totalMinutes, doneBytes, totalBytes})
//   onStalled()        אין התקדמות 30 שניות
//   onOffline()        אין רשת בכלל
//   onResumedOnline()  הרשת חזרה וההעלאה ממשיכה
//   onDone()           הסתיים, כולל אישור השרת
//   onFatal(err)       כשל סופי (לא רשת): דורש בן אדם
export function createUploader(cb) {
  let cancelled = false;
  let lastProgressAt = 0;
  let stallTimer = null;

  function armStallWatch() {
    clearInterval(stallTimer);
    lastProgressAt = Date.now();
    stallTimer = setInterval(() => {
      if (Date.now() - lastProgressAt > STALL_MS) cb.onStalled();
    }, 5000);
  }

  async function run(blob, state) {
    if (DEV) {
      // מצב תצוגה: מדמים העלאה קצרה בלי שרת
      const totalMinutes = Math.max(1, Math.round(state.durationS / 60));
      for (let i = 1; i <= 5 && !cancelled; i++) {
        await sleep(500);
        cb.onProgress({
          doneMinutes: Math.round((totalMinutes * i) / 5),
          totalMinutes,
          doneBytes: (blob.size * i) / 5,
          totalBytes: blob.size,
        });
      }
      if (!cancelled) {
        await clearUploadState();
        await clearUploadBlob();
        await clearChunks();
        cb.onDone();
      }
      return;
    }

    armStallWatch();
    const totalBytes = blob.size;
    const totalMinutes = Math.max(1, Math.round(state.durationS / 60));
    const totalParts = Math.max(1, Math.ceil(totalBytes / PART_SIZE));
    let attempt = 0;

    const report = (doneBytes) => {
      lastProgressAt = Date.now();
      cb.onProgress({
        doneMinutes:
          Math.round(((doneBytes / totalBytes) * totalMinutes) * 10) / 10,
        totalMinutes,
        doneBytes,
        totalBytes,
      });
    };

    while (!cancelled) {
      try {
        if (!navigator.onLine) {
          cb.onOffline();
          await waitForOnline();
          cb.onResumedOnline();
        }

        // שלב 1: פתיחת סשן העלאה (אם אין כזה שמור)
        if (!state.uploadId) {
          const created = await api("/upload/create", {
            body: { recordingId: state.recordingId, mime: state.mime },
          });
          state.key = created.key;
          state.uploadId = created.uploadId;
          state.etags = {};
          await saveUploadState(state);
        }

        // שלב 2: העלאת החלקים שעוד לא עלו
        const authToken = await getAccessToken();
        for (let part = 1; part <= totalParts; part++) {
          if (cancelled) return;
          if (state.etags[part]) continue;
          const start = (part - 1) * PART_SIZE;
          const chunk = blob.slice(start, Math.min(start + PART_SIZE, totalBytes));
          const doneBefore = Object.keys(state.etags).length
            ? Object.keys(state.etags)
                .map(Number)
                .reduce(
                  (s, p) =>
                    s + Math.min(PART_SIZE, totalBytes - (p - 1) * PART_SIZE),
                  0
                )
            : 0;
          const { etag } = await putPart({
            url:
              WORKER_URL +
              `/upload/part?key=${encodeURIComponent(state.key)}&uploadId=${encodeURIComponent(state.uploadId)}&part=${part}`,
            blob: chunk,
            authToken,
            onProgress: (loaded) => report(doneBefore + loaded),
          });
          state.etags[part] = etag;
          await saveUploadState(state);
          attempt = 0;
        }

        // שלב 3: סגירה. השרת מאחד את החלקים ומסמן את ההקלטה כמוכנה.
        await api("/upload/complete", {
          body: {
            recordingId: state.recordingId,
            key: state.key,
            uploadId: state.uploadId,
            sizeBytes: totalBytes,
            parts: Object.entries(state.etags).map(([n, etag]) => ({
              partNumber: Number(n),
              etag,
            })),
          },
        });

        clearInterval(stallTimer);
        await clearUploadState();
        await clearUploadBlob();
        await clearChunks();
        cb.onDone();
        return;
      } catch (err) {
        if (cancelled) return;
        // שגיאת הרשאה או סשן שפג: מתחילים סשן חדש פעם אחת
        if (err.status === 404 || err.status === 400) {
          if (!state.retriedFresh) {
            state.retriedFresh = true;
            state.uploadId = null;
            state.etags = {};
            await saveUploadState(state);
            continue;
          }
          clearInterval(stallTimer);
          cb.onFatal(err);
          return;
        }
        if (err.status === 401 || err.status === 403) {
          clearInterval(stallTimer);
          cb.onFatal(err);
          return;
        }
        // שגיאת רשת או שרת: ממתינים וממשיכים מאותה נקודה, בלי הגבלת ניסיונות
        attempt++;
        const wait = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(1.6, attempt));
        await sleep(wait);
      }
    }
  }

  return {
    // התחלת העלאה חדשה. persistBlob=true שומר עותק להמשכה אחרי סגירת דף
    // (הקלטות מהאתר). לקובץ מהגלריה לא שומרים עותק (חוסך אחסון כפול).
    async start({ blob, recordingId, durationS, mime, source, fileName, persistBlob }) {
      const state = {
        recordingId,
        durationS,
        mime,
        source,
        fileName: fileName || null,
        fileSize: blob.size,
        uploadId: null,
        etags: {},
        startedAt: Date.now(),
      };
      await saveUploadState(state);
      if (persistBlob) {
        try {
          await saveUploadBlob(blob);
        } catch (e) {
          /* אין מקום לעותק: ההעלאה עדיין רצה מהזיכרון */
        }
      }
      return run(blob, state);
    },
    // המשכת העלאה שמורה. אם אין blob (קובץ גלריה אחרי סגירת דף),
    // הקורא צריך לבקש מהמשתמש לבחור את הקובץ שוב.
    async resume(state, blob) {
      let b = blob;
      if (!b) b = await getUploadBlob();
      if (!b) return { needsFile: true };
      return run(b, state);
    },
    stop() {
      cancelled = true;
      clearInterval(stallTimer);
    },
  };
}
