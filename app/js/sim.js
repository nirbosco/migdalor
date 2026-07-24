// חותמטק: מרכז הסימולציות. עמוד לצוות בלבד (מוביל בית או אדמין):
// צילום סימולציה (פריסטייל או בהגבלת זמן לבחירה), העלאה מיידית,
// ואולפן הקרנה בסגנון עורך וידאו: ציר זמן עם בלוקים, סימון קטעים,
// ניגון ברצף ומצב הקרנה למקרן.
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
  firstName, deleteRecording } from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, clock, watchOnline } from "./ui.js";
import { createRecorder } from "./recorder.js";
import { createUploader, getUploadState } from "./upload.js";
import { saveUploadState, saveUploadBlob, estimateSpaceMinutes } from "./store.js";

// הגבלת זמן: לבחירת המצלם/ת במסך ההכנה. null = פריסטייל, בלי עצירה.
let timeLimitS = null;

let user = null;
let profile = null;
let isAdmin = false;
let rec = null;          // מנוע ההקלטה
let uploading = false;
let autoStopped = false; // מגן מפני עצירה כפולה בתקרת הזמן

// הסימולציה שנמצאת עכשיו בזרימת "אחרי הצילום"
let current = null; // { recordingId, title }

// ---------- נתוני הדגמה (?dev=1) ----------
// הסימולציה הראשונה מדמה 8 דקות עם 3 קטעים, כדי שציר הזמן ייבחן במלואו.

const DEV_SIMS = [
  {
    id: "dev-sim-1",
    title: "סימולציה 09:40",
    duration_s: 480,
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
    { id: "dev-mark-1", recording_id: "dev-sim-1", t_start: 62, t_end: 118, label: "פתיחת השיחה" },
    { id: "dev-mark-2", recording_id: "dev-sim-1", t_start: 205, t_end: 262, label: "רגע ההקשבה" },
    { id: "dev-mark-3", recording_id: "dev-sim-1", t_start: 388, t_end: 452, label: "סגירה וסיכום" },
  ],
  "dev-sim-2": [],
};

let devMarkSeq = 10;

// מצב תצוגה: מדמים סימולציה שעולה מהטלפון ומבשילה, כדי לבחון את
// הרענון השקט (חלק ב של הבריף) בלי טלפון אמיתי.
function scheduleDevPhoneSim() {
  if (!DEV) return;
  setTimeout(() => {
    DEV_SIMS.unshift({
      id: "dev-sim-phone",
      title: "סימולציה מהטלפון",
      duration_s: 0,
      created_at: new Date().toISOString(),
      status: "uploading",
      owner_id: "00000000-0000-0000-0000-00000000dev1",
      ownerName: "",
    });
  }, 9000);
  setTimeout(() => {
    const row = DEV_SIMS.find((s) => s.id === "dev-sim-phone");
    if (row) {
      row.status = "ready";
      row.duration_s = 372;
    }
  }, 22000);
}

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

// שורה אחת, לרענון החי של הבמה כשהסימולציה עוד בהעלאה
async function fetchSimRow(id) {
  if (DEV) return DEV_SIMS.find((s) => s.id === id) || null;
  const { data, error } = await supabase
    .from("migdalor_recordings")
    .select("id,title,duration_s,created_at,status,owner_id")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
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

async function updateMarkLabel(mark, label) {
  if (DEV) {
    const arr = DEV_MARKS[mark.recording_id] || [];
    const row = arr.find((m) => m.id === mark.id);
    if (row) row.label = label;
    return;
  }
  const { error } = await supabase
    .from("migdalor_sim_marks")
    .update({ label })
    .eq("id", mark.id);
  if (error) throw error;
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

  scheduleDevPhoneSim();
  await showHome();
}

// ---------- בית: הרשימה ----------

async function showHome() {
  document.body.classList.remove("stage", "projecting", "dev-video");
  stopStage();
  if (rec) rec.stopStream();
  goScreen("screen-home");
  await Promise.all([renderPendingUpload(), renderList()]);
  startListRefresh();
}

function simTimeOfDay(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// שורת סימולציה אחת ברשימה
function buildSimRow(s, isNew) {
  const card = document.createElement("div");
  card.className = "card sim-row" + (isNew ? " row-new" : "");

  const info = document.createElement("div");
  info.className = "sim-info";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = s.title || "סימולציה";
  if (isNew) {
    const badge = document.createElement("span");
    badge.className = "badge-new";
    badge.textContent = "חדש";
    title.appendChild(badge);
    setTimeout(() => badge.classList.add("fading"), 6000);
    setTimeout(() => badge.remove(), 7000);
  }
  const meta = document.createElement("div");
  meta.className = "meta";
  const parts = [humanDate(s.created_at), simTimeOfDay(s.created_at)];
  if (s.duration_s) parts.push(humanMinutes(s.duration_s));
  if (s.ownerName) parts.push(s.ownerName);
  meta.textContent = parts.filter(Boolean).join(" | ");
  info.append(title, meta);
  // לחיצה על הכרטיס פותחת את האולפן: גם לסימולציה שעדיין בהעלאה
  // (שם מחכה הודעה חיה שמתעדכנת לבד).
  if (s.status !== "failed") info.addEventListener("click", () => openStage(s));
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
  // מחיקה: זמינה תמיד (גם להעלאה שנכשלה), עם אישור
  const delBtn = document.createElement("button");
  delBtn.className = "row-action row-action-danger";
  delBtn.textContent = "מחיקה";
  delBtn.addEventListener("click", async () => {
    const name = s.title || "הסימולציה";
    if (!confirm(`למחוק את "${name}"? המחיקה לצמיתות, כולל הסרטון והקטעים המסומנים.`)) return;
    delBtn.disabled = true;
    delBtn.textContent = "מוחק...";
    try {
      await deleteRecording(s.id);
      knownSimIds.delete(s.id);
      await renderList();
    } catch (e) {
      alert("המחיקה לא הצליחה: " + (e.message || e));
      delBtn.disabled = false;
      delBtn.textContent = "מחיקה";
    }
  });
  card.appendChild(delBtn);
  return card;
}

// הסימולציות שכבר מוצגות, כדי שהרענון השקט ידע מה חדש
let knownSimIds = new Set();
let listSignature = "";
let listTimer = null;

function renderRows(sims, markNew) {
  const list = $("simList");
  list.innerHTML = "";
  show($("listEmpty"), !sims.length);
  for (const s of sims) {
    const isNew = markNew && !knownSimIds.has(s.id);
    list.appendChild(buildSimRow(s, isNew));
  }
  knownSimIds = new Set(sims.map((s) => s.id));
  listSignature = sims.map((s) => `${s.id}:${s.status}:${s.title}:${s.duration_s}`).join("|");
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
  renderRows(sims, false);
}

// ---- רענון שקט: סימולציה שעולה מהטלפון מופיעה במחשב בלי מגע ----

const REFRESH_MS = DEV ? 5000 : 12000;

function startListRefresh() {
  if (listTimer) return;
  listTimer = setInterval(refreshListQuiet, REFRESH_MS);
}

async function refreshListQuiet() {
  if (document.hidden) return;
  const home = document.querySelector("#screen-home.active");
  if (!home) return;
  let sims;
  try {
    sims = await listSims();
  } catch (e) {
    return; // שקט: הרשימה הקיימת נשארת, הניסיון הבא בעוד רגע
  }
  const sig = sims.map((s) => `${s.id}:${s.status}:${s.title}:${s.duration_s}`).join("|");
  if (sig === listSignature) return;
  renderRows(sims, true);
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
    $("spaceLine").textContent = "לא הצלחנו לבדוק כמה מקום פנוי יש. סימולציה קצרה כמעט תמיד נכנסת.";
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
  if (timeLimitS == null) {
    $("recTimer").textContent = clock(s);
    return;
  }
  const left = timeLimitS - s;
  $("recTimer").textContent = clock(Math.min(s, timeLimitS));
  if (left <= 60 && left > 0) {
    $("recWarn").textContent = `נשארה פחות מדקה. הצילום ייעצר לבד ב-${clock(timeLimitS)}.`;
    show($("recWarn"), true);
  }
  if (s >= timeLimitS && !autoStopped) {
    autoStopped = true;
    stopAndFinish();
  }
}

// ---------- בחירת הגבלת הזמן ----------
function wireLimitChooser() {
  const free = $("limitFree"), timed = $("limitTimed"), mins = $("limitMinutes");
  if (!free || !timed) return;
  const saved = localStorage.getItem("hotamtech_sim_limit");
  if (saved && saved !== "free") {
    mins.value = saved;
    free.classList.remove("selected");
    timed.classList.add("selected");
  }
  const pick = (isTimed) => {
    free.classList.toggle("selected", !isTimed);
    timed.classList.toggle("selected", isTimed);
    localStorage.setItem("hotamtech_sim_limit", isTimed ? String(currentMins()) : "free");
  };
  const currentMins = () => Math.max(1, Math.min(60, parseInt(mins.value, 10) || 10));
  free.addEventListener("click", () => pick(false));
  timed.addEventListener("click", () => pick(true));
  mins.addEventListener("change", () => { mins.value = currentMins(); pick(true); });
  mins.addEventListener("click", (e) => { e.stopPropagation(); pick(true); });
}

// נקרא ברגע תחילת צילום: קובע את ההגבלה לריצה הזו
function applyChosenLimit() {
  const timed = $("limitTimed");
  const mins = $("limitMinutes");
  if (timed && timed.classList.contains("selected")) {
    timeLimitS = Math.max(1, Math.min(60, parseInt(mins.value, 10) || 10)) * 60;
  } else {
    timeLimitS = null;
  }
}

async function startRecording() {
  applyChosenLimit();
  $("recHint").textContent = timeLimitS == null
    ? "מקליטים ושומרים. עוצרים בכפתור כשמסיימים."
    : `מקליטים ושומרים. הצילום ייעצר לבד ב-${clock(timeLimitS)}.`;
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

/* ============================================================
   האולפן: מסך ההקרנה בסגנון עורך וידאו
   ============================================================ */

// מצב האולפן
let stageSim = null;      // הרשומה המוצגת
let marks = [];           // הקטעים המסומנים של הסימולציה הפתוחה
let pendingStart = null;  // שניות, אחרי "סמן התחלה"
let pendingEnd = null;    // שניות, אחרי "סמן סוף"
let segStopAt = null;     // עצירה אוטומטית בסוף קטע מתנגן
let playingMarkId = null;
let stageReady = false;   // false בזמן שהסימולציה עוד בהעלאה

// רצף: "הקרנת כל הקטעים ברצף"
let seqActive = false;
let seqIdx = 0;

// נגן מדומה במצב תצוגה (אין סרטון אמיתי): זמן שמתקדם באמת,
// כדי שציר הזמן, הסימון והרצף ייבחנו כמו בנגן אמיתי.
let devVideo = false;
let devT = 0;
let devPlaying = false;

let playRate = 1;
const RATES = [1, 1.25, 1.5, 2];

let rafId = null;
let lastTs = null;
let stagePollTimer = null;
let overlayTimer = null;

// ---- עטיפת הנגן: וידאו אמיתי או שעון מדומה ----

function stageDuration() {
  if (devVideo) return stageSim && stageSim.duration_s ? stageSim.duration_s : 480;
  const v = $("stagePlayer");
  if (isFinite(v.duration) && v.duration > 0) return v.duration;
  return (stageSim && stageSim.duration_s) || 0;
}

function stageTime() {
  if (devVideo) return devT;
  return $("stagePlayer").currentTime || 0;
}

function stageSeek(t) {
  if (!stageReady) return;
  const d = stageDuration();
  const clamped = Math.max(0, Math.min(d || 0, t));
  if (devVideo) devT = clamped;
  else $("stagePlayer").currentTime = clamped;
  drawFrame();
}

function stagePlay() {
  if (!stageReady) return;
  if (devVideo) {
    if (devT >= stageDuration() - 0.05) devT = 0;
    devPlaying = true;
  } else {
    $("stagePlayer").play().catch(() => {});
  }
}

function stagePause() {
  if (devVideo) devPlaying = false;
  else $("stagePlayer").pause();
}

function stageIsPlaying() {
  if (devVideo) return devPlaying;
  const v = $("stagePlayer");
  return !v.paused && !v.ended;
}

function togglePlay() {
  if (stageIsPlaying()) {
    stagePause();
    // עצירה ידנית מנקה ניגון-קטע ורצף
    segStopAt = null;
    if (seqActive) endSequence();
    if (playingMarkId) {
      playingMarkId = null;
      renderMarks();
      hideOverlay();
    }
  } else {
    stagePlay();
  }
}

function applyRate() {
  if (!devVideo) $("stagePlayer").playbackRate = playRate;
  $("tSpeed").textContent = `מהירות ×${playRate}`;
}

// ---- לולאת הציור: playhead חלק ב-requestAnimationFrame ----

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
let shownPlaying = null;

function drawFrame() {
  const d = stageDuration();
  const t = stageTime();

  // playhead
  const track = $("tlTrack");
  const w = track.clientWidth;
  const x = d > 0 ? (Math.min(t, d) / d) * w : 0;
  $("tlPlayhead").style.transform = `translateX(${x}px)`;

  // שעון
  $("tCur").textContent = clock(t);

  // בלוק חי בזמן סימון
  if (pendingStart !== null && d > 0) {
    const live = document.getElementById("tlLive");
    if (live) {
      const end = pendingEnd !== null ? pendingEnd : Math.max(t, pendingStart + 1);
      live.style.left = `${(pendingStart / d) * 100}%`;
      live.style.width = `${(Math.min(end, d) - pendingStart) / d * 100}%`;
    }
  }

  // אייקון נגן/השהה
  const playing = stageIsPlaying();
  if (playing !== shownPlaying) {
    shownPlaying = playing;
    const btn = $("tPlay");
    btn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    btn.setAttribute("aria-label", playing ? "השהה" : "נגן");
  }
}

function stageLoop(ts) {
  rafId = requestAnimationFrame(stageLoop);
  const dt = lastTs === null ? 0 : (ts - lastTs) / 1000;
  lastTs = ts;

  // התקדמות הנגן המדומה
  if (devVideo && devPlaying) {
    devT += dt * playRate;
    const d = stageDuration();
    if (devT >= d) {
      devT = d;
      devPlaying = false;
      segStopAt = null;
      if (seqActive) endSequence();
      if (playingMarkId) { playingMarkId = null; renderMarks(); hideOverlay(); }
    }
  }

  // עצירה בסוף קטע (בודדת או ברצף)
  if (segStopAt !== null && stageTime() >= segStopAt - 0.04) {
    if (seqActive) {
      advanceSequence();
    } else {
      stagePause();
      segStopAt = null;
      playingMarkId = null;
      renderMarks();
      hideOverlay();
    }
  }

  drawFrame();
}

function startStageLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  lastTs = null;
  shownPlaying = null;
  rafId = requestAnimationFrame(stageLoop);
}

function stopStage() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (stagePollTimer) clearInterval(stagePollTimer);
  stagePollTimer = null;
  const v = $("stagePlayer");
  v.pause();
  devPlaying = false;
  segStopAt = null;
  playingMarkId = null;
  seqActive = false;
  hideOverlay();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---- פתיחת האולפן ----

async function openStage(sim) {
  stopStage();
  stageSim = sim;
  marks = [];
  pendingStart = null;
  pendingEnd = null;
  segStopAt = null;
  playingMarkId = null;
  seqActive = false;
  devT = 0;
  devPlaying = false;
  playRate = 1;
  stageReady = false;
  devVideo = false;

  document.body.classList.add("stage");
  document.body.classList.remove("projecting", "dev-video");
  goScreen("screen-stage");

  setStageTitleInput(sim.title || "סימולציה");
  const parts = [humanDate(sim.created_at), simTimeOfDay(sim.created_at)];
  if (sim.duration_s) parts.push(humanMinutes(sim.duration_s));
  if (sim.ownerName) parts.push(`צילם: ${sim.ownerName}`);
  $("stageMeta").textContent = parts.filter(Boolean).join(" · ");
  $("stageNote").textContent = "";
  resetMarkPanel();
  renderMarks();
  applyRate();
  show($("stageWait"), false);

  if (sim.status !== "ready") {
    enterStageWait();
    return;
  }
  await loadStageMedia();
}

// הסימולציה עוד עולה: הודעה חיה שמתעדכנת לבד עד שהיא מוכנה
function enterStageWait() {
  show($("stageWait"), true);
  document.body.classList.add("dev-video"); // יחס 16:9 לבמה גם בלי וידאו
  $("devPoster").style.display = "none";
  $("markStartBtn").disabled = true;
  $("markEndBtn").disabled = true;
  let dots = 0;
  const baseLine = "הסימולציה עדיין עולה מהטלפון. המסך יתעדכן לבד ברגע שהיא מוכנה";
  $("stageWaitLine").textContent = baseLine + "...";
  stagePollTimer = setInterval(async () => {
    dots = (dots + 1) % 4;
    $("stageWaitLine").textContent = baseLine + ".".repeat(dots + 1);
    try {
      const row = await fetchSimRow(stageSim.id);
      if (row && row.status === "ready") {
        clearInterval(stagePollTimer);
        stagePollTimer = null;
        stageSim = { ...stageSim, ...row };
        show($("stageWait"), false);
        document.body.classList.remove("dev-video");
        $("devPoster").style.display = "";
        setStageTitleInput(stageSim.title || "סימולציה");
        const parts = [humanDate(stageSim.created_at), simTimeOfDay(stageSim.created_at)];
        if (stageSim.duration_s) parts.push(humanMinutes(stageSim.duration_s));
        $("stageMeta").textContent = parts.filter(Boolean).join(" · ");
        await loadStageMedia();
      } else if (row && row.status === "failed") {
        clearInterval(stagePollTimer);
        stagePollTimer = null;
        $("stageWaitLine").textContent =
          "ההעלאה מהטלפון נכשלה. חוזרים לטלפון וממשיכים אותה מהכרטיס במסך הראשי.";
      }
    } catch (e) {
      /* בעיית תקשורת רגעית: הניסיון הבא בעוד רגע */
    }
  }, 4000);
}

async function loadStageMedia() {
  const v = $("stagePlayer");
  stageReady = true;
  $("markStartBtn").disabled = false;

  if (DEV) {
    v.removeAttribute("src");
    devVideo = true;
    document.body.classList.add("dev-video");
  } else {
    const jwt = await getAccessToken();
    // הבעלים מזרים דרך נתיב הבעלים של ה-Worker, כמו בצפייה עצמית בשיעור
    v.src =
      WORKER_URL +
      "/mine/" +
      encodeURIComponent(stageSim.id) +
      "?auth=" +
      encodeURIComponent(jwt);
  }

  buildTimeline();

  try {
    marks = await listMarks(stageSim.id);
  } catch (e) {
    marks = [];
    $("stageNote").textContent = "לא הצלחנו להביא את הקטעים המסומנים. מרעננים ומנסים שוב.";
  }
  renderMarks();
  startStageLoop();
}

// שם הסימולציה בפס העליון: שדה שנראה ככותרת ונערך בלחיצה
function setStageTitleInput(title) {
  const inp = $("stageTitle");
  inp.value = title;
  sizeStageTitle();
}

function sizeStageTitle() {
  const inp = $("stageTitle");
  inp.style.width = Math.min(40, Math.max(8, inp.value.length + 2)) + "ch";
}

async function saveStageTitle() {
  const inp = $("stageTitle");
  const title = inp.value.trim() || "סימולציה";
  inp.value = title;
  sizeStageTitle();
  if (!stageSim || title === stageSim.title) return;
  stageSim.title = title;
  try {
    await updateSimTitle(stageSim.id, title);
  } catch (e) {
    $("stageNote").textContent = "שינוי השם לא נשמר כרגע, זו כנראה בעיית תקשורת רגעית.";
  }
}

// ---- ציר הזמן ----

// צפיפות שנתות לפי משך: כל 30 שניות לקצרים, דקה לבינוניים, וכן הלאה
function tickStepFor(d) {
  if (d <= 180) return 30;
  if (d <= 720) return 60;
  if (d <= 1800) return 120;
  return 300;
}

function tickLabel(t) {
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function buildTimeline() {
  const d = stageDuration();
  const ruler = $("tlRuler");
  const ticks = $("tlTicks");
  ruler.innerHTML = "";
  ticks.innerHTML = "";
  if (!(d > 0)) {
    $("tlNote").textContent = "משך הסרטון יתברר ברגע שהניגון יתחיל.";
    return;
  }
  const step = tickStepFor(d);
  for (let t = step; t < d - step * 0.25; t += step) {
    const pct = (t / d) * 100;
    const tick = document.createElement("div");
    tick.className = "tl-tick major";
    tick.style.left = pct + "%";
    ticks.appendChild(tick);
    const lbl = document.createElement("span");
    lbl.style.left = pct + "%";
    lbl.textContent = tickLabel(t);
    ruler.appendChild(lbl);
    // שנת משנה באמצע
    const mid = t - step / 2;
    if (mid > 0) {
      const half = document.createElement("div");
      half.className = "tl-tick";
      half.style.left = (mid / d) * 100 + "%";
      ticks.appendChild(half);
    }
  }
  const lastMid = Math.floor((d - step * 0.25) / step) * step + step / 2;
  if (lastMid < d) {
    const half = document.createElement("div");
    half.className = "tl-tick";
    half.style.left = (lastMid / d) * 100 + "%";
    ticks.appendChild(half);
  }
  $("tDur").textContent = clock(d);
  renderTimelineBlocks();
}

function renderTimelineBlocks() {
  const d = stageDuration();
  const box = $("tlBlocks");
  box.innerHTML = "";
  if (!(d > 0)) return;
  marks.forEach((m, i) => {
    const el = document.createElement("div");
    el.className = "tl-block" + (m.id === playingMarkId ? " selected" : "");
    el.style.left = (m.t_start / d) * 100 + "%";
    el.style.width = Math.max(0.8, ((m.t_end - m.t_start) / d) * 100) + "%";
    el.title = `${m.label || "קטע"} · ${clock(m.t_start)}-${clock(m.t_end)}`;
    const lbl = document.createElement("span");
    lbl.className = "bl";
    lbl.textContent = m.label || `קטע ${i + 1}`;
    el.appendChild(lbl);
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      playMark(m);
    });
    box.appendChild(el);
  });
  // הבלוק החי של סימון פתוח
  if (pendingStart !== null) {
    const live = document.createElement("div");
    live.id = "tlLive";
    live.className = "tl-block live";
    live.style.left = (pendingStart / d) * 100 + "%";
    live.style.width = "0.8%";
    box.appendChild(live);
  }
  $("tlNote").textContent = marks.length
    ? "לחיצה על בלוק מנגנת את הקטע. לחיצה או גרירה על הציר קופצת לנקודה."
    : "לחיצה או גרירה על הציר קופצת לנקודה. הקטעים המסומנים יופיעו כאן כבלוקים כחולים.";
}

// לחיצה או גרירה על הציר קופצת לנקודה
function wireTimeline() {
  const track = $("tlTrack");
  let dragging = false;
  const seekFromEvent = (e) => {
    const d = stageDuration();
    if (!(d > 0)) return;
    const rect = track.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    stageSeek(frac * d);
  };
  track.addEventListener("pointerdown", (e) => {
    if (!stageReady) return;
    dragging = true;
    track.setPointerCapture(e.pointerId);
    // גרירה ידנית מבטלת ניגון-קטע ורצף
    segStopAt = null;
    if (seqActive) endSequence();
    seekFromEvent(e);
  });
  track.addEventListener("pointermove", (e) => {
    if (dragging) seekFromEvent(e);
  });
  const stop = () => (dragging = false);
  track.addEventListener("pointerup", stop);
  track.addEventListener("pointercancel", stop);
}

// ---- שכבת שם הקטע על הבמה ----

function showOverlay(idxText, name, sticky) {
  if (overlayTimer) clearTimeout(overlayTimer);
  $("segOverlayIdx").textContent = idxText || "";
  show($("segOverlayIdx"), !!idxText);
  $("segOverlayName").textContent = name || "";
  $("segOverlay").classList.add("on");
  if (!sticky) {
    overlayTimer = setTimeout(() => $("segOverlay").classList.remove("on"), 2800);
  }
}

function hideOverlay() {
  if (overlayTimer) clearTimeout(overlayTimer);
  overlayTimer = null;
  $("segOverlay").classList.remove("on");
}

// ---- סימון קטעים ----

function resetMarkPanel() {
  pendingStart = null;
  pendingEnd = null;
  $("markStartBtn").disabled = !stageReady;
  $("markStartBtn").classList.remove("arm");
  $("markEndBtn").disabled = true;
  $("markEndBtn").classList.remove("arm");
  $("markSaveBtn").disabled = true;
  $("markLabel").value = "";
  show($("markPending"), false);
  show($("markError"), false);
  renderTimelineBlocks();
}

function markStart() {
  pendingStart = Math.floor(stageTime());
  pendingEnd = null;
  $("markStartBtn").disabled = true;
  $("markEndBtn").disabled = false;
  $("markEndBtn").classList.add("arm");
  $("markSaveBtn").disabled = true;
  show($("markPending"), true);
  show($("markError"), false);
  $("markPendingLine").textContent =
    `התחלה סומנה ב-${clock(pendingStart)}. ממשיכים לנגן, ובסוף הקטע לוחצים "סמן סוף".`;
  renderTimelineBlocks();
}

function markEnd() {
  const t = Math.floor(stageTime());
  if (pendingStart === null) return;
  if (t <= pendingStart) {
    $("markError").textContent = "הסוף חייב להיות אחרי ההתחלה. מנגנים קדימה ולוחצים שוב.";
    show($("markError"), true);
    return;
  }
  pendingEnd = t;
  $("markEndBtn").disabled = true;
  $("markEndBtn").classList.remove("arm");
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

// ---- פאנל הקטעים ----

function segDurText(m) {
  const s = Math.max(0, Math.round(m.t_end - m.t_start));
  if (s < 60) return `${s} שנ'`;
  const mns = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${mns}:${String(rem).padStart(2, "0")} דק'` : `${mns} דק'`;
}

function renderMarks() {
  const list = $("segList");
  list.innerHTML = "";
  show($("segEmpty"), !marks.length);
  $("segCount").textContent = String(marks.length);
  const playAll = $("playAllBtn");
  playAll.disabled = !marks.length || !stageReady;

  marks.forEach((m, i) => {
    const card = document.createElement("div");
    card.className = "seg-card" + (m.id === playingMarkId ? " playing" : "");

    const top = document.createElement("div");
    top.className = "sc-top";
    const name = document.createElement("div");
    name.className = "sc-name";
    name.textContent = m.label || `קטע ${i + 1}`;
    const times = document.createElement("span");
    times.className = "sc-times";
    times.textContent = `${clock(m.t_start)}-${clock(m.t_end)}`;
    const dur = document.createElement("span");
    dur.className = "sc-dur";
    dur.textContent = segDurText(m);
    top.append(name, times, dur);
    card.appendChild(top);

    const actions = document.createElement("div");
    actions.className = "sc-actions";

    const play = document.createElement("button");
    play.type = "button";
    play.className = "sc-btn sc-play";
    play.textContent = m.id === playingMarkId ? "מתנגן..." : "נגן קטע";
    play.addEventListener("click", () => playMark(m));
    actions.appendChild(play);

    const rename = document.createElement("button");
    rename.type = "button";
    rename.className = "sc-btn";
    rename.textContent = "שינוי שם";
    rename.addEventListener("click", () => editMarkLabel(m, name));
    actions.appendChild(rename);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "sc-btn sc-del";
    del.textContent = "מחיקה";
    del.addEventListener("click", async () => {
      if (!confirm("למחוק את הקטע הזה?")) return;
      try {
        await deleteMark(m);
        marks = marks.filter((x) => x.id !== m.id);
        if (playingMarkId === m.id) {
          playingMarkId = null;
          segStopAt = null;
        }
        renderMarks();
      } catch (e) {
        $("markError").textContent = "המחיקה לא הצליחה כרגע. מנסים שוב בעוד רגע.";
        show($("markError"), true);
      }
    });
    actions.appendChild(del);

    card.appendChild(actions);
    list.appendChild(card);
  });

  renderTimelineBlocks();
}

// עריכת שם קטע במקום: השם הופך לשדה, Enter או יציאה שומרים
function editMarkLabel(m, nameEl) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.maxLength = 60;
  inp.value = m.label || "";
  nameEl.textContent = "";
  nameEl.appendChild(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const label = inp.value.trim() || m.label || "קטע";
    if (save && label !== m.label) {
      try {
        await updateMarkLabel(m, label);
        m.label = label;
      } catch (e) {
        $("markError").textContent = "שינוי השם לא נשמר כרגע. מנסים שוב בעוד רגע.";
        show($("markError"), true);
      }
    }
    renderMarks();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => finish(true));
}

// ---- ניגון קטע בודד ורצף ----

function playMark(m, idxText) {
  if (!stageReady) return;
  stageSeek(m.t_start);
  segStopAt = m.t_end;
  playingMarkId = m.id;
  renderMarks();
  stagePlay();
  const projecting = document.body.classList.contains("projecting");
  showOverlay(idxText || "", m.label || "קטע", projecting);
}

function playAllSegments() {
  if (seqActive) {
    endSequence();
    stagePause();
    segStopAt = null;
    playingMarkId = null;
    renderMarks();
    hideOverlay();
    return;
  }
  if (!marks.length) return;
  seqActive = true;
  seqIdx = 0;
  const btn = $("playAllBtn");
  btn.classList.add("stopping");
  btn.innerHTML = "עצירת הרצף";
  playSeqSegment();
}

function playSeqSegment() {
  const m = marks[seqIdx];
  if (!m) {
    endSequence();
    return;
  }
  playMark(m, `${seqIdx + 1}/${marks.length}`);
}

function advanceSequence() {
  seqIdx += 1;
  if (seqIdx >= marks.length) {
    stagePause();
    segStopAt = null;
    playingMarkId = null;
    endSequence();
    renderMarks();
    hideOverlay();
    return;
  }
  playSeqSegment();
}

function endSequence() {
  seqActive = false;
  seqIdx = 0;
  const btn = $("playAllBtn");
  btn.classList.remove("stopping");
  btn.innerHTML =
    '<svg viewBox="0 0 16 16"><path d="M3 2.5v11l9-5.5z"/></svg> הקרנת כל הקטעים ברצף';
  btn.disabled = !marks.length || !stageReady;
}

// ---- הנגן האמיתי: חיווט חד-פעמי ----

// קובצי webm של MediaRecorder עלולים להגיע בלי משך: קפיצה לסוף מאלצת
// את הדפדפן לחשב אותו, ואז חוזרים להתחלה (כמו במסך הצפייה).
function wireStagePlayer() {
  const v = $("stagePlayer");
  v.addEventListener("loadedmetadata", () => {
    if (v.duration === Infinity) {
      const back = () => {
        v.removeEventListener("seeked", back);
        v.currentTime = 0;
        buildTimeline();
      };
      v.addEventListener("seeked", back);
      v.currentTime = 1e7;
    } else {
      buildTimeline();
    }
  });
  v.addEventListener("error", () => {
    if (DEV || !v.src) return;
    $("stageNote").textContent =
      stageSim && stageSim.owner_id !== user.id
        ? "ההזרמה זמינה כרגע רק למי שצילם את הסימולציה. מקרינים מהמכשיר שצילם."
        : "הסרטון לא נטען. זו כנראה בעיית תקשורת רגעית, מרעננים את הדף ומנסים שוב.";
  });
  // לחיצה על הבמה מנגנת או משהה, כמו בעורך
  v.addEventListener("click", togglePlay);
  $("devPoster").addEventListener("click", togglePlay);
}

// ---- מצב הקרנה ----

function enterProjection() {
  document.body.classList.add("projecting");
  const studio = $("studioRoot");
  if (studio.requestFullscreen) {
    // מסך מלא זה נחמד אבל לא חובה: גם בלעדיו המצב נקי למקרן
    studio.requestFullscreen().catch(() => {});
  }
}

function exitProjection() {
  document.body.classList.remove("projecting");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---- מקלדת: רווח נגן/השהה, חצים 5 שניות, Esc יציאה מהקרנה ----

function stageKeydown(e) {
  if (!document.querySelector("#screen-stage.active")) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === " " || e.code === "Space") {
    e.preventDefault();
    togglePlay();
  } else if (e.key === "ArrowLeft") {
    e.preventDefault();
    stageSeek(stageTime() - 5);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    stageSeek(stageTime() + 5);
  } else if (e.key === "Escape") {
    if (document.body.classList.contains("projecting")) exitProjection();
  }
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

  // קישורי המדריך שומרים על מצב התצוגה (?dev=1)
  $("guideLink").href = devHref("sim-guide.html");
  $("stageGuideLink").href = devHref("sim-guide.html");

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
  wireLimitChooser();
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

  // האולפן
  $("markStartBtn").addEventListener("click", markStart);
  $("markEndBtn").addEventListener("click", markEnd);
  $("markSaveBtn").addEventListener("click", saveMark);
  $("markCancelBtn").addEventListener("click", resetMarkPanel);
  $("playAllBtn").addEventListener("click", playAllSegments);
  $("projBtn").addEventListener("click", enterProjection);
  $("exitProjBtn").addEventListener("click", exitProjection);
  $("stageBackBtn").addEventListener("click", showHome);

  $("tPlay").addEventListener("click", togglePlay);
  $("tBack5").addEventListener("click", () => stageSeek(stageTime() - 5));
  $("tFwd5").addEventListener("click", () => stageSeek(stageTime() + 5));
  $("tSpeed").addEventListener("click", () => {
    playRate = RATES[(RATES.indexOf(playRate) + 1) % RATES.length];
    applyRate();
  });

  $("stageTitle").addEventListener("input", sizeStageTitle);
  $("stageTitle").addEventListener("change", saveStageTitle);
  $("stageTitle").addEventListener("keydown", (e) => {
    if (e.key === "Enter") e.target.blur();
  });

  document.addEventListener("keydown", stageKeydown);
  // יציאה ממסך מלא (Esc של הדפדפן) מחזירה גם את הפריסה הרגילה
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && document.body.classList.contains("projecting")) {
      document.body.classList.remove("projecting");
    }
  });

  wireTimeline();
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
