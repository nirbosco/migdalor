// חותמטק: המסך של החותם. כניסה, בית, הכנה, הקלטה, העלאה ושיתוף.
// המסע הוא קו ישר: בית, צילום, סיום ושיתוף, בית. בלי ניווט, בלי תפריטים.

import { DEV, devHref, CONTACT_NAME, CONTACT_PHONE, REC_TARGET } from "./config.js";
import {
  supabase,
  getUser,
  signInWithGoogle,
  getMyProfile,
  isInRoster,
  submitJoinRequest,
  listMyMentors,
  listMyRecordings,
  createRecording,
  updateRecordingTitle,
  markRecordingFailed,
  getOrCreateToken,
  shareWithMentors,
  firstName,
} from "./supa.js";
import {
  $,
  show,
  goScreen as _goScreen,
  defaultLessonName,
  humanDate,
  humanMinutes,
  clock,
  joinNames,
  isInAppBrowser,
  watchOnline,
  copyText,
} from "./ui.js";
import { createRecorder, findLeftoverRecording, assembleLeftover } from "./recorder.js";
import { createUploader, getUploadState } from "./upload.js";
import { saveUploadState, saveUploadBlob, estimateSpaceMinutes } from "./store.js";
import { initDashShell } from "./dash-shell.js";

// עטיפה ל-goScreen: מסך הבית מקבל דשבורד רחב (home-dash), שאר מסכי
// הזרימה החמה נשארים בעמודה הצרה. כך הבית "דשבורדי" בלי לגעת בהקלטה.
function goScreen(id) {
  document.body.classList.toggle("home-dash", id === "screen-home");
  _goScreen(id);
}

let profile = null;
let mentors = [];
let rec = null;
let uploader = null;
let uploading = false;

// ההקלטה או הקובץ שנמצאים עכשיו בזרימת "אחרי העצירה"
let current = null; // {recordingId, blob, durationS, mime, source, title, fileName}

// לאן מדווחת ההעלאה: מסך "אחרי" או כרטיס הבית
let uploadUI = null;

const humanContact = () =>
  CONTACT_PHONE
    ? `אפשר גם להתקשר ל${CONTACT_NAME}: ${CONTACT_PHONE}.`
    : "";

// ---------- אתחול ----------

async function boot() {
  if (DEV) document.body.classList.add("dev");
  initDashShell();
  watchOnline();

  if (isInAppBrowser()) {
    goScreen("screen-inapp");
    return;
  }

  const user = await getUser();
  if (!user) {
    goScreen("screen-login");
    return;
  }

  try {
    const inRoster = await isInRoster(user.email);
    if (!inRoster) {
      goScreen("screen-join");
      return;
    }
    profile = await getMyProfile();
  } catch (e) {
    goScreen("screen-login");
    $("loginError").textContent =
      "משהו לא הסתדר אצלנו בכניסה. מנסים שוב בעוד רגע, והכול יעבוד. " +
      humanContact();
    show($("loginError"), true);
    return;
  }

  // מנטור ואדמין מגיעים ישר למסך שלהם (עם דרך חזרה מפורשת)
  const params = new URLSearchParams(location.search);
  if (!params.has("stay")) {
    if (profile.role === "mentor") {
      location.replace(devHref("mentor.html"));
      return;
    }
    if (profile.role === "admin") {
      location.replace(devHref("admin.html"));
      return;
    }
  }

  if (!localStorage.getItem("migdalor_welcomed")) {
    $("welcomeTitle").textContent = `שלום ${firstName(profile.full_name) || ""}, ברוך הבא`.trim();
    goScreen("screen-welcome");
    return;
  }

  await showHome();
}

// ---------- בית ----------

async function showHome() {
  $("homeGreeting").textContent = `שלום, ${firstName(profile.full_name) || ""}`.trim();

  // קישורים שקטים לבעלי תפקידים
  if (profile.role === "mentor" || profile.role === "admin") {
    show($("roleLinks"), true);
    show($("mentorLink"), true);
    $("mentorLink").href = devHref("mentor.html");
    if (profile.role === "admin") {
      show($("adminLink"), true);
      show($("roleLinksSep"), true);
      $("adminLink").href = devHref("admin.html");
    }
  }

  goScreen("screen-home");
  await Promise.all([renderPendingUpload(), renderLessons()]);
}

// טקסט + סוג badge לפי מצב השיעור
function lessonStatus(l) {
  if (l.status === "failed")
    return { text: "העלאה נכשלה", full:
      `משהו השתבש בהעלאה, אבל הסרטון עצמו שמור אצלך ובטוח. הודענו לצוות, ` +
      `ו${CONTACT_NAME} יחזור אליך לעזור. ` + humanContact(), cls: "tag tag-stuck" };
  if (l.status === "uploading")
    return { text: "ממתין להעלאה", full: "ממתין להשלמת ההעלאה.", cls: "tag" };
  if (l.viewedBy.length)
    return { text: "נצפה", full: `נשלח ל${joinNames(l.sharedWith)}, נצפה`, cls: "tag tag-ok" };
  if (l.sharedWith.length)
    return { text: "שותף", full: `נשלח ל${joinNames(l.sharedWith)}`, cls: "tag" };
  return { text: "לא שותף", full: "עדיין לא שותף", cls: "tag" };
}

async function renderLessons() {
  show($("lessonsError"), false);
  show($("lessonsEmpty"), false);
  $("lessonsCard").hidden = true;
  show($("homeStats"), false);
  $("homeStats").hidden = true;
  $("lessonsList").innerHTML = "";
  $("lessonsCards").innerHTML = "";
  $("lessonsLoading").classList.remove("hidden");
  let lessons;
  try {
    lessons = await listMyRecordings();
  } catch (e) {
    $("lessonsLoading").classList.add("hidden");
    show($("lessonsError"), true);
    return;
  }
  $("lessonsLoading").classList.add("hidden");
  if (!lessons.length) {
    show($("lessonsEmpty"), true);
    return;
  }

  // רצועת סיכום קצרה
  const shared = lessons.filter((l) => l.sharedWith && l.sharedWith.length).length;
  const viewed = lessons.filter((l) => l.viewedBy && l.viewedBy.length).length;
  $("homeStatLessons").textContent = lessons.length;
  $("homeStatShared").textContent = shared;
  $("homeStatViewed").textContent = viewed;
  $("homeStats").hidden = false;
  show($("homeStats"), true);

  $("lessonsCard").hidden = false;
  for (const l of lessons) {
    const st = lessonStatus(l);
    const title = l.title || "שיעור ללא שם";
    const ready = l.status === "ready";
    const watch = () => { if (ready) watchLesson(l); };
    const share = (e) => { if (e) e.stopPropagation(); if (ready) openShareMode(l); };

    // שורת טבלה (דסקטופ). לחיצה על השורה מנגנת את השיעור; כפתור נפרד לשיתוף.
    const tr = document.createElement("tr");
    const tdTitle = document.createElement("td");
    tdTitle.className = "lesson-title-cell";
    tdTitle.textContent = title;
    const tdDate = document.createElement("td");
    tdDate.textContent = humanDate(l.created_at);
    const tdDur = document.createElement("td");
    tdDur.textContent = humanMinutes(l.duration_s);
    const tdStatus = document.createElement("td");
    tdStatus.innerHTML = `<span class="${st.cls}">${st.text}</span>`;
    const tdAction = document.createElement("td");
    if (ready) {
      const watchBtn = document.createElement("button");
      watchBtn.className = "row-action";
      watchBtn.textContent = "צפייה";
      watchBtn.addEventListener("click", (e) => { e.stopPropagation(); watch(); });
      const shareBtn = document.createElement("button");
      shareBtn.className = "row-action row-action-ghost";
      shareBtn.textContent = "שיתוף";
      shareBtn.addEventListener("click", share);
      tdAction.append(watchBtn, shareBtn);
    }
    tr.append(tdTitle, tdDate, tdDur, tdStatus, tdAction);
    if (ready) { tr.style.cursor = "pointer"; tr.addEventListener("click", watch); }
    else tr.style.cursor = "default";
    $("lessonsList").appendChild(tr);

    // כרטיס (מובייל)
    const card = document.createElement("div");
    card.className = "trow-card";
    const head = document.createElement("div");
    head.className = "tc-head";
    const nm = document.createElement("span");
    nm.className = "tc-name";
    nm.textContent = title;
    const tag = document.createElement("span");
    tag.className = st.cls;
    tag.style.marginInlineStart = "auto";
    tag.textContent = st.text;
    head.append(nm, tag);
    const grid = document.createElement("div");
    grid.className = "tc-grid";
    grid.innerHTML =
      `<div class="tc-field"><span class="k">תאריך</span><span class="v"></span></div>` +
      `<div class="tc-field"><span class="k">משך</span><span class="v"></span></div>`;
    grid.querySelectorAll(".v")[0].textContent = humanDate(l.created_at);
    grid.querySelectorAll(".v")[1].textContent = humanMinutes(l.duration_s);
    card.append(head, grid);
    if (l.status !== "ready" || st.text !== "לא שותף") {
      const note = document.createElement("div");
      note.className = "status";
      note.style.marginTop = "8px";
      note.textContent = st.full;
      if (l.viewedBy.length) note.classList.add("viewed");
      card.appendChild(note);
    }
    if (ready) {
      const actions = document.createElement("div");
      actions.className = "tc-actions";
      const watchBtn = document.createElement("button");
      watchBtn.className = "row-action";
      watchBtn.textContent = "צפייה";
      watchBtn.addEventListener("click", (e) => { e.stopPropagation(); watch(); });
      const shareBtn = document.createElement("button");
      shareBtn.className = "row-action row-action-ghost";
      shareBtn.textContent = "שיתוף";
      shareBtn.addEventListener("click", share);
      actions.append(watchBtn, shareBtn);
      card.appendChild(actions);
      card.style.cursor = "pointer";
      card.addEventListener("click", watch);
    }
    $("lessonsCards").appendChild(card);
  }
}

// פתיחת נגן לצפייה עצמית של הבעלים בהקלטה שלו.
// אם השיעור כבר שותף (יש טוקן), משתמשים בנתיב הטוקן הקיים — ה-can_view
// כבר מתיר לבעלים, וצפיית הבעלים אינה נרשמת כ"נצפה". אם לא שותף, נתיב
// הבעלים לפי מזהה ההקלטה (בלי טוקן).
function watchLesson(l) {
  const q = l.token
    ? "watch.html?token=" + encodeURIComponent(l.token)
    : "watch.html?rec=" + encodeURIComponent(l.id);
  location.href = devHref(q);
}

// כרטיס העלאה ממתינה או שיעור ששרד קריסה
async function renderPendingUpload() {
  const cardEl = $("pendingUploadCard");
  show(cardEl, false);
  if (uploading) return; // ההעלאה כבר רצה ומדווחת בעצמה

  const state = await getUploadState();
  if (state) {
    show(cardEl, true);
    const title = state.title || defaultLessonName(new Date(state.startedAt));
    $("pendingTitle").textContent = title;
    $("pendingStatus").textContent = title.startsWith("שיעור")
      ? `ה${title} שמור אצלך וממתין להעלאה.`
      : `השיעור שמור אצלך וממתין להעלאה.`;
    show($("pendingTrack"), false);
    const btn = $("resumeUploadBtn");
    show(btn, true);
    btn.onclick = async () => {
      show(btn, false);
      bindUploadToHomeCard(state);
      const res = await startResume(state);
      if (res && res.needsFile) {
        $("pendingStatus").textContent =
          "כדי להמשיך, בוחרים שוב את הסרטון מהגלריה של הטלפון.";
        show(btn, true);
        btn.textContent = "לבחור את הסרטון";
        btn.onclick = () => pickFileForResume(state);
      }
    };
    return;
  }

  // אין מצב העלאה, אבל אולי יש הקלטה ששרדה קריסה
  const leftover = await findLeftoverRecording();
  if (leftover) {
    show(cardEl, true);
    $("pendingTitle").textContent = "נמצא שיעור שצולם ולא הועלה";
    $("pendingStatus").textContent =
      "הכול בסדר: הצילום שמור אצלך בטלפון. אפשר לשמור ולהעלות אותו עכשיו.";
    show($("pendingTrack"), false);
    const btn = $("resumeUploadBtn");
    show(btn, true);
    btn.textContent = "לשמור ולהעלות";
    btn.onclick = async () => {
      const assembled = await assembleLeftover();
      if (!assembled) {
        show(cardEl, false);
        return;
      }
      startAfterFlow({
        blob: assembled.blob,
        mime: assembled.mime,
        durationS: assembled.durationS,
        source: "rec",
      });
    };
  }
}

function bindUploadToHomeCard(state) {
  show($("pendingTrack"), true);
  uploadUI = {
    line: $("pendingStatus"),
    fill: $("pendingFill"),
    notice: null,
  };
}

function pickFileForResume(state) {
  const input = $("galleryFile");
  input.onchange = async () => {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    if (state.fileSize && file.size !== state.fileSize) {
      $("pendingStatus").textContent =
        "זה לא אותו סרטון. בוחרים את הסרטון המקורי כדי להמשיך בדיוק מאותה נקודה.";
      return;
    }
    bindUploadToHomeCard(state);
    show($("resumeUploadBtn"), false);
    await startResume(state, file);
  };
  input.click();
}

async function startResume(state, blob) {
  // אם השורה בשרת עוד לא נוצרה (היינו אופליין), יוצרים אותה עכשיו
  if (!state.recordingId) {
    try {
      const row = await createRecording({
        title: state.title || defaultLessonName(new Date(state.startedAt)),
        duration_s: state.durationS,
        mime: state.mime,
      });
      state.recordingId = row.id;
      await saveUploadState(state);
    } catch (e) {
      if (uploadUI && uploadUI.line) {
        uploadUI.line.textContent =
          "אין אינטרנט כרגע, והסרטון שמור אצלך בטלפון. ברגע שהטלפון יתחבר לרשת, הוא יעלה לבד.";
      }
      window.addEventListener("online", () => startResume(state, blob), { once: true });
      return;
    }
  }
  uploading = true;
  uploader = createUploader(uploadCallbacks(state));
  const res = await uploader.resume(state, blob);
  if (res && res.needsFile) uploading = false;
  return res;
}

// ---------- הכנה לצילום ----------

function wirePrep() {
  $("newLessonBtn").addEventListener("click", async () => {
    // שיעור אחד עולה בכל פעם: אם יש העלאה פתוחה, קודם מסיימים אותה
    const state = await getUploadState();
    if (state && !uploading) {
      alert("יש שיעור קודם שממתין להעלאה. קודם מסיימים להעלות אותו (בכרטיס למעלה), ואז מצלמים חדש.");
      return;
    }
    goScreen("screen-prep1");
  });
  $("prep1Next").addEventListener("click", () => goScreen("screen-prep2"));
  $("prep2Next").addEventListener("click", () => {
    goScreen("screen-prep3");
    show($("prep3Ask"), true);
    show($("prep3Denied"), false);
    show($("prep3Ready"), false);
  });
  document.querySelectorAll(".back-home").forEach((b) =>
    b.addEventListener("click", async () => {
      if (rec) rec.stopStream();
      await showHome();
    })
  );

  $("openCameraBtn").addEventListener("click", openPrepCamera);
  $("retryCameraBtn").addEventListener("click", openPrepCamera);
  $("camSel").addEventListener("change", switchPrepDevices);
  $("micSel").addEventListener("change", switchPrepDevices);
  $("startRecordBtn").addEventListener("click", startRecording);
}

async function openPrepCamera() {
  rec = createRecorder({
    onTimer: (s) => ($("recTimer").textContent = clock(s)),
    onMeter: (state) => {
      const set = (el) => {
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
      set($("prepMic"));
      set($("recMic"));
    },
    onSpace: onRecordingSpace,
    onInterrupted: onInterrupted,
    onSaveError: () => {
      $("recSpaceWarn").textContent =
        "בעיה בשמירה לטלפון. כדאי ללחוץ סיום ולשמור את מה שצולם עד עכשיו.";
      show($("recSpaceWarn"), true);
    },
  });
  if (DEV && !navigator.mediaDevices) {
    // אין מצלמה בסביבת התצוגה
    show($("prep3Ask"), false);
    show($("prep3Ready"), true);
    $("spaceLine").textContent = "מצב תצוגה: אין מצלמה אמיתית.";
    return;
  }
  try {
    await rec.openPreview($("prepVideo"));
  } catch (e) {
    show($("prep3Ask"), false);
    show($("prep3Ready"), false);
    show($("prep3Denied"), true);
    $("deniedHelp").textContent = permissionHelp();
    return;
  }
  show($("prep3Ask"), false);
  show($("prep3Denied"), false);
  show($("prep3Ready"), true);
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
  const fill = (sel, list, current, fallback) => {
    sel.innerHTML = "";
    list.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || `${fallback} ${i + 1}`;
      if (d.deviceId === current) o.selected = true;
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
  const est = await estimateSpaceMinutes(REC_TARGET.videoBps);
  if (!est) {
    $("spaceLine").textContent =
      "לא הצלחנו לבדוק כמה מקום פנוי יש. אם הטלפון לא מלא לגמרי, אפשר להתחיל.";
    return;
  }
  if (est.minutes >= 60) {
    $("spaceLine").textContent = "יש מקום בטלפון לשעה של צילום.";
  } else if (est.minutes > 0) {
    $("spaceLine").textContent = `יש מקום ל-${est.minutes} דקות צילום.`;
  } else {
    $("spaceLine").textContent =
      "אין כמעט מקום פנוי בטלפון. כדאי לפנות קצת מקום לפני שמתחילים.";
  }
}

// ---------- הקלטה ----------

async function startRecording() {
  goScreen("screen-record");
  $("recVideo").srcObject = $("prepVideo").srcObject;
  show($("stopConfirm"), false);
  show($("recSpaceWarn"), false);
  $("recSpace").textContent = "";
  try {
    await rec.begin();
    rec.wasRecordingScreen = true;
  } catch (e) {
    goScreen("screen-prep3");
    show($("prep3Ask"), false);
    show($("prep3Denied"), true);
    $("deniedHelp").textContent = permissionHelp();
  }
}

function onRecordingSpace(minutes) {
  if (minutes === null) return;
  if (minutes <= 0) {
    $("recSpaceWarn").textContent =
      "המקום בטלפון נגמר, אז שמרנו את כל מה שצולם עד עכשיו. הכול תקין.";
    show($("recSpaceWarn"), true);
    stopAndFinish();
    return;
  }
  if (minutes <= 10) {
    $("recSpaceWarn").textContent = `נשארו ${minutes} דקות מקום. כדאי לסיים את השיעור בקרוב.`;
    show($("recSpaceWarn"), true);
  } else {
    $("recSpace").textContent = ` | נשאר מקום ל-${minutes} דקות`;
  }
}

function onInterrupted(elapsedSeconds) {
  rec.wasRecordingScreen = false;
  $("interruptedMsg").textContent =
    `הכול בסדר. ההקלטה נשמרה עד לרגע ההפרעה (${clock(elapsedSeconds)}). אפשר להמשיך לצלם מכאן.`;
  goScreen("screen-interrupted");
}

function wireRecording() {
  $("stopBtn").addEventListener("click", () => show($("stopConfirm"), true));
  $("stopNo").addEventListener("click", () => show($("stopConfirm"), false));
  $("stopYes").addEventListener("click", stopAndFinish);

  $("resumeRecBtn").addEventListener("click", async () => {
    // פותחים מחדש את המצלמה וממשיכים את אותה הקלטה
    try {
      await rec.openPreview($("recVideo"));
      goScreen("screen-record");
      show($("stopConfirm"), false);
      await rec.begin({ resume: true });
      rec.wasRecordingScreen = true;
    } catch (e) {
      goScreen("screen-prep3");
      show($("prep3Ask"), false);
      show($("prep3Denied"), true);
      $("deniedHelp").textContent = permissionHelp();
    }
  });
  $("finishHereBtn").addEventListener("click", stopAndFinish);
}

async function stopAndFinish() {
  rec.wasRecordingScreen = false;
  show($("stopConfirm"), false);
  const result = await rec.finish();
  if (!result) {
    goScreen("screen-after-empty");
    return;
  }
  startAfterFlow({ ...result, source: "rec" });
}

// ---------- מסלול ב: קובץ מהגלריה ----------

function wireGallery() {
  $("fromGalleryBtn").addEventListener("click", async () => {
    const state = await getUploadState();
    if (state && !uploading) {
      alert("יש שיעור קודם שממתין להעלאה. קודם מסיימים להעלות אותו (בכרטיס למעלה), ואז שולחים חדש.");
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
  });
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

// ---------- אחרי העצירה: העלאה ושיתוף ----------

async function startAfterFlow({ blob, mime, durationS, source, fileName }) {
  current = {
    recordingId: null,
    blob,
    mime,
    durationS,
    source,
    fileName,
    title: defaultLessonName(),
    token: null,
  };
  resetAfterScreen(false);
  $("afterHeadline").textContent = "כל הכבוד, השיעור צולם ושמור.";
  $("lessonTitle").value = current.title;
  goScreen("screen-after");
  loadMentorsInto();

  // מצב ההעלאה נשמר עוד לפני שנוצרה שורה בשרת, כדי ששום ניתוק לא יאבד כלום
  const state = {
    recordingId: null,
    durationS,
    mime,
    source,
    fileName: fileName || null,
    fileSize: blob.size,
    title: current.title,
    uploadId: null,
    etags: {},
    startedAt: Date.now(),
  };
  await saveUploadState(state);
  if (source === "rec") {
    try {
      await saveUploadBlob(blob);
    } catch (e) {
      /* אין מקום לעותק: ההעלאה עדיין רצה מהזיכרון */
    }
  }

  uploadUI = {
    line: $("uploadLine"),
    fill: $("uploadFill"),
    notice: $("uploadNotice"),
  };

  // יצירת השורה בשרת והתחלת ההעלאה
  try {
    const row = await createRecording({
      title: current.title,
      duration_s: durationS,
      mime,
    });
    current.recordingId = row.id;
    state.recordingId = row.id;
    await saveUploadState(state);
  } catch (e) {
    $("uploadLine").textContent =
      "אין אינטרנט כרגע, והסרטון שמור אצלך בטלפון. ברגע שהטלפון יתחבר לרשת " +
      "(למשל בבית או בנסיעה לבאר שבע), הוא יעלה לבד. אפשר לסגור בראש שקט.";
    window.addEventListener(
      "online",
      async () => {
        const res = await startResume(state, blob);
        if (res && res.needsFile) {
          $("uploadLine").textContent =
            "כדי להמשיך את ההעלאה, בוחרים שוב את הסרטון מהגלריה.";
        }
      },
      { once: true }
    );
    return;
  }

  uploading = true;
  uploader = createUploader(uploadCallbacks(state));
  uploader.resume(state, blob);
}

function uploadCallbacks(state) {
  return {
    onProgress: ({ doneMinutes, totalMinutes, doneBytes, totalBytes }) => {
      if (!uploadUI) return;
      uploadUI.line.textContent =
        `עולה לענן: ${Math.min(doneMinutes, totalMinutes)} מתוך ${totalMinutes} דקות. ` +
        `אפשר להניח את הטלפון בצד, רק לא לסגור את החלון הזה.`;
      if (uploadUI.fill) {
        uploadUI.fill.style.width = `${Math.min(100, (doneBytes / totalBytes) * 100)}%`;
      }
      if (uploadUI.notice) show(uploadUI.notice, false);
    },
    onStalled: () => {
      if (!uploadUI || !uploadUI.notice) return;
      uploadUI.notice.textContent =
        "החיבור איטי כרגע, אבל אנחנו ממשיכים לנסות. הסרטון שמור אצלך בטלפון ולא יאבד. אין צורך לעשות כלום.";
      show(uploadUI.notice, true);
    },
    onOffline: () => {
      if (!uploadUI) return;
      uploadUI.line.textContent =
        "אין אינטרנט כרגע, והסרטון שמור אצלך בטלפון. ברגע שהטלפון יתחבר לרשת " +
        "(למשל בבית או בנסיעה לבאר שבע), הוא יעלה לבד. אפשר לסגור בראש שקט.";
    },
    onResumedOnline: () => {
      if (!uploadUI) return;
      uploadUI.line.textContent = "החיבור חזר, ממשיכים להעלות מאותה נקודה.";
    },
    onDone: async () => {
      uploading = false;
      if (uploadUI) {
        uploadUI.line.textContent = "השיעור עלה בשלמותו ושמור בענן.";
        if (uploadUI.fill) uploadUI.fill.style.width = "100%";
        if (uploadUI.notice) show(uploadUI.notice, false);
      }
      // שיתופים שנבחרו בזמן שההעלאה רצה כבר נוצרו; רק מרעננים את הבית ברקע
      if (state.pendingMentors && state.pendingMentors.length && state.recordingId) {
        try {
          await shareWithMentors(state.recordingId, state.pendingMentors);
        } catch (e) {
          /* יטופל בכניסה הבאה דרך הכרטיס */
        }
      }
    },
    onFatal: async () => {
      uploading = false;
      if (state.recordingId) await markRecordingFailed(state.recordingId);
      const msg =
        `משהו השתבש בהעלאה, אבל הסרטון עצמו שמור אצלך ובטוח. הודענו לצוות, ` +
        `ו${CONTACT_NAME} יחזור אליך לעזור. ` +
        humanContact();
      if (uploadUI) {
        if (uploadUI.notice) {
          uploadUI.notice.textContent = msg;
          show(uploadUI.notice, true);
        } else {
          uploadUI.line.textContent = msg;
        }
      }
    },
  };
}

// מסך "אחרי" עבור שיעור קיים (שיתוף מאוחר): בלי כרטיס העלאה
function openShareMode(lesson) {
  current = {
    recordingId: lesson.id,
    blob: null,
    durationS: lesson.duration_s,
    source: "existing",
    title: lesson.title,
    token: lesson.token,
  };
  resetAfterScreen(true);
  $("afterHeadline").textContent = lesson.title || "השיעור שלך";
  $("lessonTitle").value = lesson.title || "";
  goScreen("screen-after");
  loadMentorsInto(lesson.sharedWith || []);
}

function resetAfterScreen(shareOnly) {
  show($("uploadCard"), !shareOnly);
  show($("uploadNotice"), false);
  $("uploadFill").style.width = "0%";
  $("uploadLine").textContent = "מתחילים להעלות...";
  show($("shareDone"), false);
  show($("waLink"), false);
  show($("copyDone"), false);
  show($("afterHomeBtn"), shareOnly);
  $("sendBtn").disabled = true;
  $("mentorList").innerHTML = "";
  show($("noMentors"), false);
}

async function loadMentorsInto(alreadySharedNames = []) {
  try {
    mentors = await listMyMentors();
  } catch (e) {
    mentors = [];
  }
  const listEl = $("mentorList");
  listEl.innerHTML = "";
  if (!mentors.length) {
    show($("noMentors"), true);
    return;
  }
  const selected = new Set();
  mentors.slice(0, 12).forEach((m) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mentor-card";
    const check = document.createElement("span");
    check.className = "check";
    const name = document.createElement("span");
    name.textContent = m.full_name;
    btn.append(check, name);
    if (alreadySharedNames.includes(m.full_name)) {
      const done = document.createElement("span");
      done.className = "small";
      done.textContent = "כבר נשלח";
      done.style.marginInlineStart = "auto";
      btn.appendChild(done);
    }
    btn.addEventListener("click", () => {
      if (selected.has(m.email)) {
        selected.delete(m.email);
        btn.classList.remove("selected");
        check.textContent = "";
      } else {
        if (selected.size >= 3) return; // עד שלושה מנטורים
        selected.add(m.email);
        btn.classList.add("selected");
        check.textContent = "✓";
      }
      $("sendBtn").disabled = selected.size === 0;
    });
    listEl.appendChild(btn);
  });
  $("sendBtn").onclick = () => sendToMentors([...selected]);
}

function watchUrl(token) {
  return new URL("watch.html?token=" + encodeURIComponent(token), location.href).href;
}

async function sendToMentors(emails) {
  if (!emails.length) return;
  $("sendBtn").disabled = true;
  const names = mentors
    .filter((m) => emails.includes(m.email))
    .map((m) => firstName(m.full_name) || m.full_name);

  if (!current.recordingId) {
    // עדיין אופליין: שומרים את הבחירה, השיתוף יקרה כשההעלאה תתחיל
    const state = await getUploadState();
    if (state) {
      state.pendingMentors = [...new Set([...(state.pendingMentors || []), ...emails])];
      await saveUploadState(state);
    }
    $("shareDone").textContent =
      `הבחירה נשמרה. ברגע שיהיה חיבור, נכין את הקישור ל${joinNames(names)} ואפשר יהיה לשלוח בוואטסאפ.`;
    show($("shareDone"), true);
    return;
  }

  let token;
  try {
    token = await shareWithMentors(current.recordingId, emails);
  } catch (e) {
    $("shareDone").textContent =
      "לא הצלחנו להכין את הקישור כרגע, זו רק בעיית תקשורת רגעית. מנסים שוב בעוד רגע. " +
      "הסרטון עצמו שמור ובטוח.";
    show($("shareDone"), true);
    $("sendBtn").disabled = false;
    return;
  }
  current.token = token;
  $("shareDone").textContent =
    `הקישור מוכן ל${joinNames(names)}. שולחים אותו בוואטסאפ בכפתור למטה, ` +
    `וכשיצפו בשיעור תראה את זה כאן.`;
  show($("shareDone"), true);

  const title = $("lessonTitle").value.trim() || current.title;
  const text =
    `שלום ${joinNames(names)}, שיתפתי איתך שיעור חדש בחותמטק: "${title}". ` +
    `צופים כאן (נכנסים עם חשבון הגוגל שלך): ${watchUrl(token)}`;
  $("waLink").href = "https://wa.me/?text=" + encodeURIComponent(text);
  show($("waLink"), true);
}

function wireAfterScreen() {
  $("lessonTitle").addEventListener("change", async () => {
    const title = $("lessonTitle").value.trim() || defaultLessonName();
    current.title = title;
    const state = await getUploadState();
    if (state) {
      state.title = title;
      await saveUploadState(state);
    }
    if (current.recordingId) {
      try {
        await updateRecordingTitle(current.recordingId, title);
      } catch (e) {
        /* יעודכן בניסיון הבא */
      }
    }
  });

  $("copyLinkBtn").addEventListener("click", async () => {
    if (!current.recordingId) {
      $("copyDone").textContent =
        "הקישור יהיה מוכן ברגע שיהיה חיבור לאינטרנט. הסרטון והבקשה שלך שמורים.";
      show($("copyDone"), true);
      return;
    }
    try {
      const token = current.token || (await getOrCreateToken(current.recordingId));
      current.token = token;
      const ok = await copyText(watchUrl(token));
      $("copyDone").textContent = ok
        ? 'הקישור הועתק. עכשיו נכנסים לחותמית ומדביקים אותו במסמך שלך (לוחצים לחיצה ארוכה ואז "הדבק").'
        : "לא הצלחנו להעתיק אוטומטית. הקישור: " + watchUrl(token);
      show($("copyDone"), true);
    } catch (e) {
      $("copyDone").textContent =
        "לא הצלחנו להכין את הקישור כרגע, זו רק בעיית תקשורת רגעית. מנסים עוד רגע.";
      show($("copyDone"), true);
    }
  });

  $("laterBtn").addEventListener("click", showHome);
  $("afterHomeBtn").addEventListener("click", showHome);
}

// ---------- חיווט כללי ----------

function wireAuth() {
  $("loginBtn").addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      $("loginError").textContent =
        "הכניסה לא הצליחה הפעם. מנסים שוב, ואם זה חוזר, " + (humanContact() || "פונים לצוות.");
      show($("loginError"), true);
    }
  });

  $("joinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await submitJoinRequest($("joinName").value.trim(), $("joinPhone").value.trim());
      $("joinForm").classList.add("hidden");
      show($("joinDone"), true);
    } catch (err) {
      $("joinError").textContent =
        "לא הצלחנו לשלוח את הפרטים כרגע. מנסים שוב בעוד רגע. " + humanContact();
      show($("joinError"), true);
    }
  });

  $("welcomeBtn").addEventListener("click", async () => {
    localStorage.setItem("migdalor_welcomed", "1");
    await showHome();
  });

  $("lessonsRetry").addEventListener("click", renderLessons);

  // אחרי חזרה מגוגל: המפגש נקלט מה-URL והמסך נטען מחדש
  if (!DEV) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
        boot();
      }
    });
  }
}

// אזהרת סגירה בזמן העלאה פעילה
window.addEventListener("beforeunload", (e) => {
  if (uploading) {
    e.preventDefault();
    e.returnValue = "";
  }
});

wireAuth();
wirePrep();
wireRecording();
wireGallery();
wireAfterScreen();
boot();
