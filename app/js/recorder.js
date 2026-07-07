// המגדלור: מנוע ההקלטה. הקוד הזה הוכח בספייק על מכשירים אמיתיים ולא הומצא מחדש:
// מקטעים ל-IndexedDB תוך כדי צילום, Wake Lock, בחירת מצלמה ומיקרופון,
// מד קול חי, בחירת mime בטוחה (webm+opus קודם), וטיפול בהפרעות.

import { REC_TARGET } from "./config.js";
import { putChunk, allChunks, clearChunks, estimateSpaceMinutes, requestPersist } from "./store.js";

// בחירת פורמט: webm+opus קודם. בכרום/אנדרואיד הצירוף mp4+AAC מדווח כנתמך
// אבל מוקלט בלי קול (ל-Chromium אין מקודד AAC). ספארי/אייפון לא תומך webm
// ולכן ייפול ל-mp4 רגיל, ושם ספארי בוחר בעצמו H.264+AAC עם קול תקין.
export function pickMime() {
  const candidates = ['video/webm;codecs="vp8,opus"', "video/webm", "video/mp4"];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

export function createRecorder(callbacks = {}) {
  const cb = Object.assign(
    {
      onTimer: () => {},        // (elapsedSeconds)
      onMeter: () => {},        // (state: "ok" | "silent" | "unknown")
      onSpace: () => {},        // (minutesLeft | null)
      onInterrupted: () => {},  // (elapsedSeconds) ההקלטה נעצרה שלא ביוזמת המשתמש
      onSaveError: () => {},    // כשל כתיבה ל-IndexedDB
    },
    callbacks
  );

  let mediaStream = null;
  let recorder = null;
  let wakeLock = null;
  let audioCtx = null;
  let meterInt = null;
  let silentMs = 0;
  let recording = false;
  let seq = 0;
  let session = Date.now();
  let startedAt = 0;
  let elapsedBase = 0;
  let timerInt = null;
  let bytesTotal = 0;
  let chunkCount = 0;
  let spaceInt = null;
  const chosenMime = pickMime();

  const savedDev = {
    cam: localStorage.getItem("migdalor_cam") || "",
    mic: localStorage.getItem("migdalor_mic") || "",
  };

  async function getStream() {
    const video = {
      width: { ideal: REC_TARGET.width },
      height: { ideal: REC_TARGET.height },
      frameRate: { ideal: 24 },
    };
    if (savedDev.cam) video.deviceId = { exact: savedDev.cam };
    const audio = savedDev.mic ? { deviceId: { exact: savedDev.mic } } : true;
    return navigator.mediaDevices.getUserMedia({ video, audio });
  }

  function stopStream() {
    stopMeter();
    if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  function startMeter(stream) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      silentMs = 0;
      meterInt = setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.008) {
          silentMs = 0;
          cb.onMeter("ok");
        } else {
          silentMs += 400;
          if (silentMs > 8000) cb.onMeter("silent");
        }
      }, 400);
    } catch (e) {
      cb.onMeter("unknown");
    }
  }

  function stopMeter() {
    clearInterval(meterInt);
    meterInt = null;
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
  }

  async function acquireWakeLock() {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) {
      /* אין Wake Lock: המסך עלול לכבות, ההקלטה עצמה ממשיכה להישמר */
    }
  }

  // פתיחת תצוגה מקדימה. מחזירה את ה-stream או זורקת שגיאת הרשאה.
  async function openPreview(videoEl) {
    try {
      mediaStream = await getStream();
    } catch (e) {
      if (savedDev.cam || savedDev.mic) {
        // מכשיר שמור שכבר לא קיים: חוזרים לברירת המחדל
        savedDev.cam = "";
        savedDev.mic = "";
        localStorage.removeItem("migdalor_cam");
        localStorage.removeItem("migdalor_mic");
        mediaStream = await getStream();
      } else {
        throw e;
      }
    }
    videoEl.srcObject = mediaStream;
    startMeter(mediaStream);
    return mediaStream;
  }

  async function listDevices() {
    let devs = [];
    try {
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      return { cams: [], mics: [], curCam: "", curMic: "" };
    }
    const vt = mediaStream && mediaStream.getVideoTracks()[0];
    const at = mediaStream && mediaStream.getAudioTracks()[0];
    return {
      cams: devs.filter((d) => d.kind === "videoinput"),
      mics: devs.filter((d) => d.kind === "audioinput"),
      curCam: vt ? vt.getSettings().deviceId : "",
      curMic: at ? at.getSettings().deviceId : "",
    };
  }

  async function switchDevices(videoEl, camId, micId) {
    savedDev.cam = camId || "";
    savedDev.mic = micId || "";
    localStorage.setItem("migdalor_cam", savedDev.cam);
    localStorage.setItem("migdalor_mic", savedDev.mic);
    stopStream();
    return openPreview(videoEl);
  }

  function watchTracks() {
    if (!mediaStream) return;
    mediaStream.getVideoTracks().forEach((t) => {
      t.onended = () => {
        // הטלפון לקח את המצלמה (שיחה נכנסת וכדומה)
        if (!recording) return;
        haltCapture();
        cb.onInterrupted(elapsedBase);
      };
    });
  }

  async function begin({ resume = false } = {}) {
    if (!mediaStream) throw new Error("no stream");
    if (!resume) {
      session = Date.now();
      seq = 0;
      elapsedBase = 0;
      bytesTotal = 0;
      chunkCount = 0;
      await clearChunks();
    }
    await requestPersist();
    recorder = new MediaRecorder(mediaStream, {
      mimeType: chosenMime,
      videoBitsPerSecond: REC_TARGET.videoBps,
      audioBitsPerSecond: REC_TARGET.audioBps,
    });
    recorder.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      bytesTotal += e.data.size;
      chunkCount++;
      try {
        await putChunk(session, seq++, e.data, chosenMime);
      } catch (err) {
        cb.onSaveError(err);
      }
    };
    recorder.start(REC_TARGET.timesliceMs);
    recording = true;
    startedAt = Date.now();
    await acquireWakeLock();
    watchTracks();
    timerInt = setInterval(() => {
      cb.onTimer(elapsedBase + (Date.now() - startedAt) / 1000);
    }, 500);
    // מעקב מקום פנוי אחת לחצי דקה
    spaceInt = setInterval(async () => {
      const est = await estimateSpaceMinutes(REC_TARGET.videoBps);
      cb.onSpace(est ? est.minutes : null);
    }, 30000);
  }

  function haltCapture() {
    if (!recording) return;
    recording = false;
    elapsedBase += (Date.now() - startedAt) / 1000;
    clearInterval(timerInt);
    clearInterval(spaceInt);
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch (e) {
      /* כבר נעצר */
    }
    stopStream();
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  // עצירה והרכבה: מחזירה את הקובץ המלא, אחרי תיקון משך ל-webm.
  async function finish() {
    haltCapture();
    // רגע לריקון המקטע האחרון
    await new Promise((r) => setTimeout(r, 800));
    const rows = await allChunks();
    if (!rows.length) return null;
    const mime = rows[0].mime || chosenMime || "video/webm";
    let blob = new Blob(rows.map((r) => r.blob), { type: mime.split(";")[0] });
    // תיקון משך: הקלטת webm נשמרת בלי Duration, ובלי זה אי אפשר לדלג
    // בציר הזמן על קובץ מרוחק. חובה על כל הקלטת webm לפני העלאה.
    if (mime.includes("webm") && window.fixWebmDuration && elapsedBase > 0) {
      try {
        blob = await window.fixWebmDuration(blob, Math.round(elapsedBase * 1000));
      } catch (e) {
        /* גם בלי התיקון הקובץ תקין לניגון מקומי */
      }
    }
    const sessions = new Set(rows.map((r) => r.session)).size;
    return {
      blob,
      mime: mime.split(";")[0],
      durationS: Math.round(elapsedBase),
      sessions,
    };
  }

  // כשהדף חוזר להיות גלוי אחרי הפרעה שהרגה את הלכידה
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible") return;
    if (recording && recorder && recorder.state === "recording") {
      await acquireWakeLock();
      return;
    }
    if (!recording && chunkCount > 0 && api.wasRecordingScreen) {
      cb.onInterrupted(elapsedBase);
    }
  });

  const api = {
    chosenMime,
    wasRecordingScreen: false, // מסומן על ידי המסך בזמן הקלטה פעילה
    openPreview,
    listDevices,
    switchDevices,
    begin,
    finish,
    stopStream,
    get elapsedSeconds() {
      return recording
        ? elapsedBase + (Date.now() - startedAt) / 1000
        : elapsedBase;
    },
    get isRecording() {
      return recording;
    },
    setElapsedBase(seconds) {
      elapsedBase = seconds;
    },
  };
  return api;
}

// שחזור: האם יש הקלטה קודמת ששמורה בטלפון?
export async function findLeftoverRecording() {
  try {
    const rows = await allChunks();
    if (!rows.length) return null;
    const size = rows.reduce((s, r) => s + r.blob.size, 0);
    return { chunks: rows.length, size, ts: rows[rows.length - 1].ts };
  } catch (e) {
    return null;
  }
}

// הרכבת שיעור מהמקטעים השמורים (בשחזור אחרי קריסה), כולל תיקון משך משוער.
export async function assembleLeftover() {
  const rows = await allChunks();
  if (!rows.length) return null;
  const mime = rows[0].mime || "video/webm";
  let blob = new Blob(rows.map((r) => r.blob), { type: mime.split(";")[0] });
  // משך משוער לפי מספר המקטעים (כל מקטע ~10 שניות)
  const durationS = rows.length * (REC_TARGET.timesliceMs / 1000);
  if (mime.includes("webm") && window.fixWebmDuration) {
    try {
      blob = await window.fixWebmDuration(blob, Math.round(durationS * 1000));
    } catch (e) {
      /* ממשיכים בלי התיקון */
    }
  }
  return { blob, mime: mime.split(";")[0], durationS: Math.round(durationS) };
}
