// חותמטק: מרכז הסימולציות. עמוד לצוות בלבד (מוביל בית או אדמין):
// צילום סימולציה עד 10 דקות, העלאה מיידית, סימון קטעים והקרנה לקבוצה.
// בלי AI ובלי ניתוחים: המנוע הוא אותו מנוע הקלטה והעלאה של השיעורים,
// והרשומות נשמרות ב-migdalor_recordings עם kind='simulation'.

import { DEV, devHref, WORKER_URL } from "./config.js";
import {
  supabase,
  getUser,
  getAccessToken,
  signInWithGoogle,
  signOut,
  getMyProfile,
  firstName,
} from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, clock, watchOnline } from "./ui.js";
import { createRecorder } from "./recorder.js";
import { createUploader, getUploadState } from "./upload.js";
import { saveUploadState, saveUploadBlob, estimateSpaceMinutes } from "./store.js";

// תקרת הסימולציה: 10 דקות, עצירה אוטומטית.
const MAX_SECONDS = 600;

let user = null;
let profile = null;
let isAdmin = false;
let rec = null;          // מנוע ההקלטה
let uploading = false;
let autoStopped = false; // מגן מפני עצירה כפולה בתקרת הזמן

// הסימולציה שנמצאת עכשיו בזרימת "אחרי הצילום"
let current = null; // { recordingId, title }

// מסך ההקרנה
let stageSim = null;      // הרשומה המוצגת
let marks = [];           // הקטעים המסומנים של הסימולציה הפתוחה
let pendingStart = null;  // שניות, אחרי "סמן התחלה"
let pendingEnd = null;    // שניות, אחרי "סמן סוף"
let segStopAt = null;     // עצירה אוטומטית בסוף קטע מתנגן
let playingMarkId = null;

// ---------- נתוני הדגמה (?dev=1) ----------

const DEV_SIMS = [
  {
    id: "dev-sim-1",
    title: "סימולציה 09:40",
    duration_s: 512,
    created_at: "2026-07-14T09:40:00Z",
    status: "ready",
    owner_id: "00000000-0000-0000-0000-00000000dev1",
    ownerName: "",
  },
  {
    id: "dev-sim-2",
    title: "סימולציה 11:15",
    duration_s: 458,
    created_at: "2026-07-14T11:15:00Z",
    status: "ready",
    owner_id: "00000000-0000-0000-0000-00000000dev1",
    ownerName: "",
  },
];

const DEV_MARKS = {
  "dev-sim-1": [
    { id: "dev-mark-1", recording_id: "dev-sim-1", t_start: 142, t_end: 170, label: "פתיחת השיחה" },
    { id: "dev-mark-2", recording_id: "dev-sim-1", t_start: 305, t_end: 351, label: "רגע ההקשבה" },
  ],
  "dev-sim-2": [],
};

let devMarkSeq = 10;

// ---------- שכבת הנתונים של הסימולציות ----------
// עמודת kind קיימת ב-migdalor_recordings (ברירת מחדל 'lesson'), ולכן
// הרשומה נוצרת כאן ישירות עם kind='simulation' ולא דרך createRecording.

async function listSims() {
  if (DEV) return [...DEV_SIMS];
  let q = supabase
    .from("migdalor_recordings")
    .select("id,title,duration_s,created_at,status,owner_id")
    .eq("kind", "simulation")
    .order("created_at", { ascending: false });
  if (!isAdmin) q = q.eq("owner_id", user.id);
  const { data, error } = await q;
  if (error) throw error;
  const sims = data || [];
  // אדמין רואה את כולן: מוסיפים את שם המצלם, אם הפרופילים נגישים
  if (isAdmin && sims.length) {
    try {
      const ids = [...new Set(sims.map((s) => s.owner_id))];
      const { data: profs } = await supabase
        .from("migdalor_profiles")
        .select("id,full_name,email")
        .in("id", ids);
      const names = {};
      (profs || []).forEach((p) => (names[p.id] = p.full_name || p.email));
      sims.forEach((s) => (s.ownerName = s.owner_id === user.id ? "" : names[s.owner_id] || ""));
    } catch (e) {
      /* בלי שמות, הרשימה עדיין שלמה */
    }
  }
  return sims;
}

async function createSimRecording({ title, duration_s, mime }) {
  if (DEV) {
    const row = {
      id: "dev-sim-new-" + Date.now(),
      title,
      duration_s,
      created_at: new Date().toISOString(),
      status: "ready",
      owner_id: user.id,
      ownerName: "",
    };
    DEV_SIMS.unshift(row);
    DEV_MARKS[row.id] = [];
    return row;
  }
  const { data, error } = await supabase
    .from("migdalor_recordings")
    .insert({
      owner_id: user.id,
      title,
      duration_s,
      mime,
      status: "uploading",
      kind: "simulation",
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateSimTitle(id, title) {
  if (DEV) {
    const row = DEV_SIMS.find((s) => s.id === id);
    if (row) row.title = title;
    return;
  }
  const { error } = await supabase
    .from("migdalor_recordings")
    .update({ title })
    .eq("id", id);
  if (error) throw error;
}

// ---- קטעים מסומנים: טבלת migdalor_sim_marks (RLS לצוות מוגדר בשרת) ----

async function listMarks(recordingId) {
  if (DEV) return [...(DEV_MARKS[recordingId] || [])];
  const { data, error } = await supabase
    .from("migdalor_sim_marks")
    .select("id,recording_id,t_start,t_end,label")
    .eq("recording_id", recordingId)
    .order("t_start", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function addMark(recordingId, tStart, tEnd, label) {
  if (DEV) {
    const row = {
      id: "dev-mark-" + devMarkSeq++,
      recording_id: recordingId,
      t_start: tStart,
      t_end: tEnd,
      label,
    };
    (DEV_MARKS[recordingId] = DEV_MARKS[recordingId] || []).push(row);
    return row;
  }
  const { data, error } = await supabase
    .from("migdalor_sim_marks")
    .insert({ recording_id: recordingId, t_start: tStart, t_end: tEnd, label })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteMark(mark) {
  if (DEV) {
    const arr = DEV_MARKS[mark.recording_id] || [];
    const i = arr.findIndex((m) => m.id === mark.id);
    if (i >= 0) arr.splice(i, 1);
    return;
  }
  const { error } = await supabase
    .from("migdalor_sim_marks")
    .delete()
    .eq("id", mark.id);
  if (error) throw error;
}

// ---------- אתחול ----------

async function boot() {
  if (DEV) document.body.classList.add("dev");
  watchOnline();

  user = await getUser();
  if (!user) {
    goScreen("screen-login");
    return;
  }

  try {
    profile = await getMyProfile();
  } catch (e) {
    profile = null;
  }
  // במצב תצוגה בלי role בכתובת מדמים מוביל בית, כדי שהעמוד ייראה בפעולה.
  const role =
    DEV && !new URLSearchParams(location.search).get("role")
      ? "mentor"
      : profile && profile.role;

  // הגנת UX בלבד: האכיפה האמיתית היא ב-RLS ובבדיקות ה-Worker בשרת.
  if (role !== "mentor" && role !== "admin") {
    $("deniedHome").href = devHref("index.html");
    goScreen("screen-denied");
    return;
  }
  isAdmin = role === "admin";
  if (isAdmin) $("listChip").textContent = "כל הסימולציות";

  await showHome();
}

// ---------- בית: הרשימה ----------

async function showHome() {
  document.body.classList.remove("stage", "projecting");
  stopStageVideo();
  if (rec) rec.stopStream();
  goScreen("screen-home");
  await Promise.all([renderPendingUpload(), renderList()]);
}

function simTimeOfDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderList() {
  show($("listError"), false);
  show($("listEmpty"), false);
  $("simList").innerHTML = "";
  $("listLoading").classList.remove("hidden");
  let sims;
  try {
    sims = await listSims();
  } catch (e) {
    $("listLoading").classList.add("hidden");
    show($("listError"), true);
    return;
  }
  $("listLoading").classList.add("hidden");
  if (!sims.length) {
    show($("listEmpty"), true);
    return;
  }
  for (const s of sims) {
    const card = document.createElement("div");
    card.className = "card sim-row";

    const info = document.createElement("div");
    info.className = "sim-info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = s.title || "סימולציה";
    const meta = document.createElement("div");
    meta.className = "meta";
    const parts = [humanDate(s.created_at), simTimeOfDay(s.created_at)];
    if (s.duration_s) parts.push(humanMinutes(s.duration_s));
    if (s.ownerName) parts.push(s.ownerName);
    meta.textContent = parts.filter(Boolean).join(" | ");
    info.append(title, meta);
    card.appendChild(info);

    if (s.status === "ready") {
      const btn = document.createElement("button");
      btn.className = "row-action";
      btn.textContent = "הקרנה";
      btn.addEventListener("click", () => openStage(s));
      card.appendChild(btn);
    } else {
      const tag = document.createElement("span");
      tag.className = s.status === "failed" ? "tag tag-stuck" : "tag";
      tag.textContent = s.status === "failed" ? "ההעלאה נכשלה" : "בהעלאה";
      card.appendChild(tag);
    }
    $("simList").appendChild(card);
  }
}

// העלאה שנשארה פתוחה מהפעם הקודמת (של סימולציה בלבד)
async function renderPendingUpload() {
  const cardEl = $("pendingCard");
  show(cardEl, false);
  if (uploading || DEV) return;
  const state = await getUploadState();
  if (!state) return;
  if (state.kind !== "simulation") return; // העלאת שיעור של הזרימה הרגילה, לא נוגעים
  show(cardEl, true);
  $("pendingTitle").textContent = state.title || "סימולציה";
  $("pendingStatus").textContent = "הסימולציה שמורה בטלפון וממתינה להעלאה.";
  show($("pendingTrack"), false);
  const btn = $("resumeUploadBtn");
  show(btn, true);
  btn.textContent = "להמשיך את ההעלאה";
  btn.onclick = async () => {
    show(btn, false);
    show($("pendingTrack"), true);
    const res = await resumeSimUpload(state, null, {
      line: $("pendingStatus"),
      fill: $("pendingFill"),
      notice: null,
    });
    if (res && res.needsFile) {
      $("pendingStatus").textContent = "כדי להמשיך, בוחרים שוב את אותו סרטון מהגלריה.";
      show(btn, true);
      btn.textContent = "לבחור את הסרטון";
      btn.onclick = () => {
        const input = $("galleryFile");
        input.onchange = async () => {
          const file = input.files[0];
          input.value = "";
          if (!file) return;
          if (state.fileSize && file.size !== state.fileSize) {
            $("pendingStatus").textContent = "זה לא אותו סרטון. בוחרים את הקובץ המקורי כדי להמשיך.";
            return;
          }
          show(btn, false);
          await resumeSimUpload(state, file, {
            line: $("pendingStatus"),
            fill: $("pendingFill"),
            notice: null,
          });
        };
        input.click();
      };
    }
  };
}

// ---------- הכנה לצילום ----------

async function startNewSim() {
  // סימולציה אחת עולה בכל פעם, וגם לא דורסים העלאת שיעור פתוחה
  const state = await getUploadState();
  if (state && !uploading) {
    if (state.kind === "simulation") {
      alert("יש סימולציה קודמת שממתינה להעלאה. קודם מסיימים אותה (בכרטיס למעלה), ואז מצלמים חדשה.");
    } else {
      alert("יש שיעור שממתין להעלאה במכשיר הזה. מסיימים אותו בעמוד השיעורים, ואז חוזרים לצלם סימולציה.");
    }
    return;
  }
  goScreen("screen-prep");
  show($("prepAsk"), true);
  show($("prepDenied"), false);
  show($("prepReady"), false);
}

function setMeter(state) {
  const note = (el) => {
    if (state === "ok") {
      el.textContent = "קול נקלט";
      el.className = el.className.replace(/ (ok|bad)/g, "") + " ok";
    } else if (state === "silent") {
      el.textContent = "לא נשמע קול!";
      el.className = el.className.replace(/ (ok|bad)/g, "") + " bad";
    } else {
      el.textContent = "";
    }
  };
  note($("prepMic"));
  note($("recMic"));
  // מד קול חזותי במסך ההכנה
  $("prepMeterFill").style.width = state === "ok" ? "88%" : "4%";
  $("prepMeterFill").style.background = state === "silent" ? "var(--adom)" : "var(--turkiz)";
}

async function openPrepCamera() {
  autoStopped = false;
  rec = createRecorder({
    onTimer: onRecTimer,
    onMeter: setMeter,
    onSpace: () => {},
    onInterrupted: (elapsed) => {
      // הפרעה באמצע (שיחה נכנסת וכדומה): שומרים מה שצולם וממשיכים להעלאה
      rec.wasRecordingScreen = false;
      $("recWarn").textContent =
        `הצילום נקטע (למשל שיחה נכנסת), אבל הכול שמור עד ${clock(elapsed)}. מעלים את מה שצולם.`;
      show($("recWarn"), true);
      stopAndFinish();
    },
    onSaveError: () => {
      $("recWarn").textContent = "בעיה בשמירה לטלפון. כדאי ללחוץ סיום ולשמור את מה שצולם.";
      show($("recWarn"), true);
    },
  });
  if (DEV && !navigator.mediaDevices) {
    show($("prepAsk"), false);
    show($("prepReady"), true);
    $("spaceLine").textContent = "מצב תצוגה: אין מצלמה אמיתית.";
    return;
  }
  try {
    await rec.openPreview($("prepVideo"));
  } catch (e) {
    show($("prepAsk"), false);
    show($("prepReady"), false);
    show($("prepDenied"), true);
    $("deniedHelp").textContent = permissionHelp();
    return;
  }
  show($("prepAsk"), false);
  show($("prepDenied"), false);
  show($("prepReady"), true);
  await fillDeviceSelects();
  await showSpaceLine();
}

function permissionHelp() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad/i.test(ua)) {
    return 'נכנסים להגדרות של הטלפון, בוחרים "ספארי", ומרשים מצלמה ומיקרופון. ואז חוזרים לכאן.';
  }
  return 'לוחצים על המנעול הקטן ליד הכתובת למעלה, בוחרים "הרשאות", ומרשים מצלמה ומיקרופון. ואז חוזרים לכאן.';
}

async function fillDeviceSelects() {
  const { cams, mics, curCam, curMic } = await rec.listDevices();
  const fill = (sel, list, currentId, fallback) => {
    sel.innerHTML = "";
    list.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `${fallback} ${i + 1}`;
      if (d.deviceId === currentId) o.selected = true;
      sel.appendChild(o);
    });
  };
  fill($("camSel"), cams, curCam, "מצלמה");
  fill($("micSel"), mics, curMic, "מיקרופון");
}

async function switchPrepDevices() {
  try {
    await rec.switchDevices($("prepVideo"), $("camSel").value, $("micSel").value);
    await fillDeviceSelects();
  } catch (e) {
    $("spaceLine").textContent = "המכשיר שנבחר לא נפתח. חוזרים לברירת המחדל.";
  }
}

async function showSpaceLine() {
  const est = await estimateSpaceMinutes(1500000);
  if (!est) {
    $("spaceLine").textContent = "לא הצלחנו לבדוק כמה מקום פנוי יש. סימולציה של 10 דקות כמעט תמיד נכנסת.";
    return;
  }
  if (est.minutes >= 12) {
    $("spaceLine").textContent = "יש מספיק מקום בטלפון לסימולציה מלאה.";
  } else if (est.minutes > 0) {
    $("spaceLine").textContent = `יש מקום ל-${est.minutes} דקות צילום בלבד. כדאי לפנות קצת מקום.`;
  } else {
    $("spaceLine").textContent = "אין כמעט מקום פנוי בטלפון. מפנים קצת מקום לפני שמתחילים.";
  }
}

// ---------- צילום ----------

function onRecTimer(s) {
  const left = MAX_SECONDS - s;
  $("recTimer").textContent = clock(Math.min(s, MAX_SECONDS));
  if (left <= 60 && left > 0) {
    $("recWarn").textContent = "נשארה פחות מדקה. הצילום ייעצר לבד ב-10:00.";
    show($("recWarn"), true);
  }
  if (s >= MAX_SECONDS && !autoStopped) {
    autoStopped = true;
    stopAndFinish();
  }
}

async function startRecording() {
  goScreen("screen-record");
  $("recVideo").srcObject = $("prepVideo").srcObject;
  show($("stopConfirm"), false);
  show($("recWarn"), false);
  autoStopped = false;
  try {
    await rec.begin();
    rec.wasRecordingScreen = true;
  } catch (e) {
    goScreen("screen-prep");
    show($("prepAsk"), false);
    show($("prepDenied"), true);
    $("deniedHelp").textContent = permissionHelp();
  }
}

async function stopAndFinish() {
  if (!rec) return;
  rec.wasRecordingScreen = false;
  show($("stopConfirm"), false);
  const result = await rec.finish();
  if (!result) {
    await showHome();
    return;
  }
  startAfterFlow({ ...result, source: "rec" });
}

// ---------- מסלול ב: קובץ מהגלריה ----------

async function pickFromGallery() {
  const state = await getUploadState();
  if (state && !uploading) {
    alert("יש העלאה קודמת שממתינה במכשיר הזה. קודם מסיימים אותה, ואז מעלים סימולציה חדשה.");
    return;
  }
  const input = $("galleryFile");
  input.onchange = async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    const durationS = await readVideoDuration(file);
    startAfterFlow({
      blob: file,
      mime: file.type || "video/mp4",
      durationS: durationS || 0,
      source: "file",
      fileName: file.name,
    });
  };
  input.click();
}

function readVideoDuration(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    const url = URL.createObjectURL(file);
    const done = (d) => {
      URL.revokeObjectURL(url);
      resolve(d && isFinite(d) ? Math.round(d) : 0);
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => done(0);
    setTimeout(() => done(v.duration), 7000);
    v.src = url;
  });
}

// ---------- העלאה מיידית ----------

function defaultSimName(d = new Date()) {
  return `סימולציה ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function startAfterFlow({ blob, mime, durationS, source, fileName }) {
  current = { recordingId: null, title: defaultSimName() };
  $("afterHeadline").textContent = "הסימולציה צולמה ושמורה";
  $("simTitle").value = current.title;
  $("uploadLine").textContent = "מתחילים להעלות...";
  $("uploadFill").style.width = "0%";
  show($("uploadNotice"), false);
  show($("toStageBtn"), false);
  goScreen("screen-after");

  // מצב ההעלאה נשמר לפני הכול, כדי ששום ניתוק לא יאבד את הצילום.
  // kind מסמן שזו העלאת סימולציה, כדי שהכרטיס בבית ידע להמשיך אותה.
  const state = {
    recordingId: null,
    durationS,
    mime,
    source,
    fileName: fileName || null,
    fileSize: blob.size,
    title: current.title,
    kind: "simulation",
    uploadId: null,
    etags: {},
    startedAt: Date.now(),
  };
  if (!DEV) {
    await saveUploadState(state);
    if (source === "rec") {
      try {
        await saveUploadBlob(blob);
      } catch (e) {
        /* אין מקום לעותק: ההעלאה עדיין רצה מהזיכרון */
      }
    }
  }

  // יצירת הרשומה בשרת עם kind='simulation'
  try {
    const row = await createSimRecording({
      title: current.title,
      duration_s: durationS,
      mime,
    });
    current.recordingId = row.id;
    state.recordingId = row.id;
    if (!DEV) await saveUploadState(state);
  } catch (e) {
    $("uploadLine").textContent =
      "אין אינטרנט כרגע, והסימולציה שמורה אצלך בטלפון. ברגע שהחיבור יחזור, ההעלאה תמשיך מהכרטיס במסך הראשי.";
    window.addEventListener(
      "online",
      () => {
        resumeSimUpload(state, blob, afterUploadUI());
      },
      { once: true }
    );
    return;
  }

  await resumeSimUpload(state, blob, afterUploadUI());
}

function afterUploadUI() {
  return {
    line: $("uploadLine"),
    fill: $("uploadFill"),
    notice: $("uploadNotice"),
  };
}

// המשך או התחלה של העלאת סימולציה, עם דיווח לכרטיס הנתון
async function resumeSimUpload(state, blob, ui) {
  // אם הרשומה עוד לא נוצרה (היינו אופליין), יוצרים אותה עכשיו
  if (!state.recordingId) {
    try {
      const row = await createSimRecording({
        title: state.title || defaultSimName(new Date(state.startedAt)),
        duration_s: state.durationS,
        mime: state.mime,
      });
      state.recordingId = row.id;
      if (!DEV) await saveUploadState(state);
    } catch (e) {
      ui.line.textContent = "אין אינטרנט כרגע. הסימולציה שמורה בטלפון ותעלה כשהחיבור יחזור.";
      window.addEventListener("online", () => resumeSimUpload(state, blob, ui), { once: true });
      return;
    }
  }
  uploading = true;
  const uploader = createUploader({
    onProgress: ({ doneMinutes, totalMinutes, doneBytes, totalBytes }) => {
      ui.line.textContent =
        `עולה לענן: ${Math.min(doneMinutes, totalMinutes)} מתוך ${totalMinutes} דקות. עוד רגע אפשר להקרין.`;
      if (ui.fill) ui.fill.style.width = `${Math.min(100, (doneBytes / totalBytes) * 100)}%`;
      if (ui.notice) show(ui.notice, false);
    },
    onStalled: () => {
      if (!ui.notice) return;
      ui.notice.textContent = "החיבור איטי כרגע, אבל ממשיכים לנסות. הסימולציה שמורה בטלפון ולא תאבד.";
      show(ui.notice, true);
    },
    onOffline: () => {
      ui.line.textContent = "אין אינטרנט כרגע. ההעלאה תמשיך לבד ברגע שהחיבור יחזור.";
    },
    onResumedOnline: () => {
      ui.line.textContent = "החיבור חזר, ממשיכים להעלות מאותה נקודה.";
    },
    onDone: () => {
      uploading = false;
      ui.line.textContent = "הסימולציה עלתה ומוכנה להקרנה.";
      if (ui.fill) ui.fill.style.width = "100%";
      if (ui.notice) show(ui.notice, false);
      const btn = $("toStageBtn");
      show(btn, true);
      btn.onclick = () =>
        openStage({
          id: state.recordingId,
          title: (current && current.title) || state.title,
          duration_s: state.durationS,
          created_at: new Date(state.startedAt).toISOString(),
          status: "ready",
          owner_id: user.id,
        });
      renderList();
    },
    onFatal: async () => {
      uploading = false;
      if (state.recordingId && !DEV) {
        try {
          await supabase
            .from("migdalor_recordings")
            .update({ status: "failed" })
            .eq("id", state.recordingId);
        } catch (e) {
          /* הסימון יקרה בניסיון הבא */
        }
      }
      const msg = "משהו השתבש בהעלאה, אבל הסרטון עצמו שמור בטלפון ובטוח. אפשר לנסות שוב מהכרטיס במסך הראשי.";
      if (ui.notice) {
        ui.notice.textContent = msg;
        show(ui.notice, true);
      } else {
        ui.line.textContent = msg;
      }
    },
  });
  return uploader.resume(state, blob);
}

// ---------- מסך ההקרנה ----------

function stopStageVideo() {
  const v = $("stagePlayer");
  v.pause();
  segStopAt = null;
  playingMarkId = null;
}

async function openStage(sim) {
  stageSim = sim;
  marks = [];
  pendingStart = null;
  pendingEnd = null;
  segStopAt = null;
  playingMarkId = null;
  devClock = 0;
  document.body.classList.add("stage");
  document.body.classList.remove("projecting");
  goScreen("screen-stage");

  $("stageTitle").textContent = sim.title || "סימולציה";
  const parts = [humanDate(sim.created_at), simTimeOfDay(sim.created_at)];
  if (sim.duration_s) parts.push(humanMinutes(sim.duration_s));
  if (sim.ownerName) parts.push(`צילם: ${sim.ownerName}`);
  $("stageMeta").textContent = parts.filter(Boolean).join(" | ");
  $("stageNote").textContent = "";
  resetMarkPanel();

  const v = $("stagePlayer");
  if (DEV) {
    v.removeAttribute("src");
    $("stageNote").textContent = "מצב תצוגה: אין כאן סרטון אמיתי, אבל סימון הקטעים עובד.";
  } else {
    const jwt = await getAccessToken();
    // הבעלים מזרים דרך נתיב הבעלים של ה-Worker, כמו בצפייה עצמית בשיעור
    v.src =
      WORKER_URL +
      "/mine/" +
      encodeURIComponent(sim.id) +
      "?auth=" +
      encodeURIComponent(jwt);
  }

  try {
    marks = await listMarks(sim.id);
  } catch (e) {
    marks = [];
    $("stageNote").textContent = "לא הצלחנו להביא את הקטעים המסומנים. מרעננים ומנסים שוב.";
  }
  renderMarks();
}

// קובצי webm של MediaRecorder עלולים להגיע בלי משך: קפיצה לסוף מאלצת
// את הדפדפן לחשב אותו, ואז חוזרים להתחלה (כמו במסך הצפייה).
function wireStagePlayer() {
  const v = $("stagePlayer");
  v.addEventListener("loadedmetadata", () => {
    if (v.duration === Infinity) {
      const back = () => {
        v.removeEventListener("seeked", back);
        v.currentTime = 0;
      };
      v.addEventListener("seeked", back);
      v.currentTime = 1e7;
    }
  });
  v.addEventListener("timeupdate", () => {
    if (segStopAt !== null && v.currentTime >= segStopAt) {
      v.pause();
      segStopAt = null;
      playingMarkId = null;
      renderMarks();
    }
  });
  v.addEventListener("error", () => {
    if (DEV || !v.src) return;
    $("stageNote").textContent =
      stageSim && stageSim.owner_id !== user.id
        ? "ההזרמה זמינה כרגע רק למי שצילם את הסימולציה. מקרינים מהמכשיר שצילם."
        : "הסרטון לא נטען. זו כנראה בעיית תקשורת רגעית, מרעננים את הדף ומנסים שוב.";
  });
}

// ---- סימון קטעים ----

// מצב תצוגה בלי סרטון אמיתי: זמן מדומה שמתקדם בכל לחיצת סימון,
// כדי שאפשר יהיה לבדוק את כל הזרימה גם בלי מצלמה ורשת.
let devClock = 0;

function stageTime() {
  const v = $("stagePlayer");
  if (DEV && !v.src) {
    devClock += 12;
    return devClock;
  }
  return Math.max(0, Math.floor(v.currentTime || 0));
}

function resetMarkPanel() {
  pendingStart = null;
  pendingEnd = null;
  $("markStartBtn").disabled = false;
  $("markEndBtn").disabled = true;
  $("markSaveBtn").disabled = true;
  $("markLabel").value = "";
  show($("markPending"), false);
  show($("markError"), false);
}

function markStart() {
  pendingStart = stageTime();
  pendingEnd = null;
  $("markStartBtn").disabled = true;
  $("markEndBtn").disabled = false;
  $("markSaveBtn").disabled = true;
  show($("markPending"), true);
  show($("markError"), false);
  $("markPendingLine").textContent =
    `התחלה סומנה ב-${clock(pendingStart)}. ממשיכים לנגן, ובסוף הקטע לוחצים "סמן סוף".`;
}

function markEnd() {
  const t = stageTime();
  if (pendingStart === null) return;
  if (t <= pendingStart) {
    $("markError").textContent = "הסוף חייב להיות אחרי ההתחלה. מנגנים קדימה ולוחצים שוב.";
    show($("markError"), true);
    return;
  }
  pendingEnd = t;
  $("markEndBtn").disabled = true;
  $("markSaveBtn").disabled = false;
  show($("markError"), false);
  $("markPendingLine").textContent =
    `הקטע: ${clock(pendingStart)} עד ${clock(pendingEnd)}. אפשר לתת לו שם ולשמור.`;
  $("markLabel").focus();
}

async function saveMark() {
  if (pendingStart === null || pendingEnd === null) return;
  const label = $("markLabel").value.trim() || `קטע ${marks.length + 1}`;
  $("markSaveBtn").disabled = true;
  try {
    const row = await addMark(stageSim.id, pendingStart, pendingEnd, label);
    marks.push(row);
    marks.sort((a, b) => a.t_start - b.t_start);
    resetMarkPanel();
    renderMarks();
  } catch (e) {
    $("markError").textContent = "השמירה לא הצליחה כרגע, זו כנראה בעיית תקשורת רגעית. מנסים שוב.";
    show($("markError"), true);
    $("markSaveBtn").disabled = false;
  }
}

function renderMarks() {
  const list = $("segList");
  list.innerHTML = "";
  show($("segEmpty"), !marks.length);
  for (const m of marks) {
    const row = document.createElement("div");
    row.className = "seg-row" + (m.id === playingMarkId ? " playing" : "");

    const play = document.createElement("button");
    play.type = "button";
    play.className = "seg-play";
    const times = document.createElement("span");
    times.className = "times";
    times.textContent = `${clock(m.t_start)}-${clock(m.t_end)}`;
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = m.label || "קטע";
    play.append(times, lbl);
    play.addEventListener("click", () => playMark(m));
    row.appendChild(play);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "seg-del";
    del.textContent = "×";
    del.setAttribute("aria-label", "מחיקת הקטע");
    del.addEventListener("click", async () => {
      if (!confirm("למחוק את הקטע הזה?")) return;
      try {
        await deleteMark(m);
        marks = marks.filter((x) => x.id !== m.id);
        renderMarks();
      } catch (e) {
        $("markError").textContent = "המחיקה לא הצליחה כרגע. מנסים שוב בעוד רגע.";
        show($("markError"), true);
      }
    });
    row.appendChild(del);

    list.appendChild(row);
  }
}

function playMark(m) {
  const v = $("stagePlayer");
  if (DEV && !v.src) {
    playingMarkId = m.id;
    renderMarks();
    $("stageNote").textContent = `מצב תצוגה: כאן הנגן היה קופץ ל-${clock(m.t_start)} ונעצר ב-${clock(m.t_end)}.`;
    return;
  }
  v.currentTime = m.t_start;
  segStopAt = m.t_end;
  playingMarkId = m.id;
  renderMarks();
  v.play().catch(() => {});
}

// ---- מצב הקרנה ----

function enterProjection() {
  document.body.classList.add("projecting");
  const v = $("stagePlayer");
  const wrap = v.closest(".video-wrap");
  if (wrap && wrap.requestFullscreen) {
    // מסך מלא זה נחמד אבל לא חובה: גם בלעדיו המצב נקי למקרן
    wrap.requestFullscreen().catch(() => {});
  }
}

function exitProjection() {
  document.body.classList.remove("projecting");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------- חיווט ----------

function wire() {
  $("loginBtn").addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      $("loginError").textContent = "הכניסה לא הצליחה הפעם. מנסים שוב, ואם זה חוזר, פונים לצוות.";
      show($("loginError"), true);
    }
  });

  $("newSimBtn").addEventListener("click", startNewSim);
  $("galleryBtn").addEventListener("click", pickFromGallery);
  $("listRetry").addEventListener("click", renderList);
  $("backAppBtn").addEventListener("click", () => (location.href = devHref("index.html?stay=1")));
  $("logoutBtn").addEventListener("click", async () => {
    try {
      await signOut();
    } catch (e) {
      /* גם אם נכשל, חוזרים לכניסה */
    }
    location.replace("sim.html");
  });

  $("openCameraBtn").addEventListener("click", openPrepCamera);
  $("retryCameraBtn").addEventListener("click", openPrepCamera);
  $("camSel").addEventListener("change", switchPrepDevices);
  $("micSel").addEventListener("change", switchPrepDevices);
  $("startRecordBtn").addEventListener("click", startRecording);
  document.querySelectorAll(".back-home").forEach((b) => b.addEventListener("click", showHome));

  $("stopBtn").addEventListener("click", () => show($("stopConfirm"), true));
  $("stopNo").addEventListener("click", () => show($("stopConfirm"), false));
  $("stopYes").addEventListener("click", stopAndFinish);

  $("simTitle").addEventListener("change", async () => {
    if (!current) return;
    const title = $("simTitle").value.trim() || defaultSimName();
    current.title = title;
    if (!DEV) {
      const state = await getUploadState();
      if (state && state.kind === "simulation") {
        state.title = title;
        await saveUploadState(state);
      }
    }
    if (current.recordingId) {
      try {
        await updateSimTitle(current.recordingId, title);
      } catch (e) {
        /* יעודכן בניסיון הבא */
      }
    }
  });

  $("markStartBtn").addEventListener("click", markStart);
  $("markEndBtn").addEventListener("click", markEnd);
  $("markSaveBtn").addEventListener("click", saveMark);
  $("markCancelBtn").addEventListener("click", resetMarkPanel);
  $("projBtn").addEventListener("click", enterProjection);
  $("exitProjBtn").addEventListener("click", exitProjection);
  $("stageBackBtn").addEventListener("click", showHome);

  wireStagePlayer();

  // אזהרת סגירה בזמן העלאה פעילה
  window.addEventListener("beforeunload", (e) => {
    if (uploading) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // אחרי חזרה מגוגל: המפגש נקלט מה-URL והמסך נטען מחדש
  if (!DEV) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
        boot();
      }
    });
  }
}

wire();
boot();
