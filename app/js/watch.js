// חותמטק: מסך הצפייה. דורש כניסת גוגל, וההרשאה נבדקת בשרת (ה-Worker):
// רק הנמען, הבעלים או אדמין רואים את הסרטון. הקישור עצמו לא סוד.

import { DEV, devHref, WORKER_URL, CONTACT_NAME, CONTACT_PHONE } from "./config.js";
import { supabase, getUser, getAccessToken, signInWithGoogle, getMyProfile } from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, atMinute, watchOnline, copyText } from "./ui.js";
import {
  analysisEnabled,
  requestAnalysis,
  getAnalysis,
  getMentorReport,
  waitForAnalysis,
  renderTraineeFeedback,
  renderMentorReport,
  wireMoments,
} from "./analysis.js";

const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const recId = params.get("rec") || "";
// מצב בעלים: החותמיסט צופה בהקלטה של עצמו, מזוהה לפי מזהה הקלטה ולא לפי טוקן שיתוף
const ownerMode = !token && !!recId;
let meta = null;
let viewRegistered = false;

async function boot() {
  if (DEV) document.body.classList.add("dev");
  watchOnline();

  if (!token && !recId) {
    goScreen("screen-badlink");
    return;
  }

  const user = await getUser();
  if (!user) {
    goScreen("screen-login");
    return;
  }
  await openLesson();
}

async function openLesson() {
  if (DEV) {
    meta = {
      recordingId: "dev-rec-1",
      title: "שיעור מיום ראשון, 5.7 (הדגמה)",
      ownerName: "משה (הדגמה)",
      durationS: 2580,
      createdAt: "2026-07-05T10:00:00Z",
      status: "ready",
    };
    showPlayer("");
    $("playerNote").textContent = "מצב תצוגה: אין כאן סרטון אמיתי.";
    show($("myTraineesBtn"), true);
    // בהדגמה: ?rec= מדמה חותמיסט, ?token= מדמה מנטור
    initAiSection(ownerMode ? "trainee" : "mentor");
    return;
  }

  const jwt = await getAccessToken();
  const metaUrl = ownerMode
    ? WORKER_URL + "/mine-meta?rec=" + encodeURIComponent(recId)
    : WORKER_URL + "/meta?token=" + encodeURIComponent(token);
  let res;
  try {
    res = await fetch(metaUrl, {
      headers: { authorization: "Bearer " + jwt },
    });
  } catch (e) {
    goScreen("screen-notready");
    $("notReadyTitle").textContent = "בעיית תקשורת רגעית";
    return;
  }
  if (res.status === 403) {
    $("deniedContact").textContent = CONTACT_PHONE
      ? `אם נראה לך שזו טעות, פונים למי ששלח את הקישור, או ל${CONTACT_NAME}: ${CONTACT_PHONE}.`
      : "אם נראה לך שזו טעות, פונים למי ששלח את הקישור.";
    goScreen("screen-denied");
    return;
  }
  if (res.status === 404) {
    goScreen("screen-badlink");
    return;
  }
  if (!res.ok) {
    goScreen("screen-notready");
    $("notReadyTitle").textContent = "בעיית תקשורת רגעית";
    return;
  }
  meta = await res.json();
  if (meta.status !== "ready") {
    goScreen("screen-notready");
    return;
  }
  const src = ownerMode
    ? WORKER_URL +
      "/mine/" +
      encodeURIComponent(meta.recordingId) +
      "?auth=" +
      encodeURIComponent(jwt)
    : WORKER_URL +
      "/v/" +
      encodeURIComponent(meta.recordingId) +
      "?token=" +
      encodeURIComponent(token) +
      "&auth=" +
      encodeURIComponent(jwt);
  showPlayer(src);

  if (ownerMode) {
    // הבעלים צופה בעצמו: כפתור חזרה לדשבורד, בלי רישום "נצפה"
    $("myTraineesBtn").textContent = "חזרה לשיעורים שלי";
    show($("myTraineesBtn"), true);
    initAiSection("trainee");
    return;
  }

  // כפתור "כל החותמיסטים שלי" למנטורים ואדמינים, ולהם גם הניתוח העמוק
  try {
    const profile = await getMyProfile();
    if (profile && (profile.role === "mentor" || profile.role === "admin")) {
      show($("myTraineesBtn"), true);
      initAiSection("mentor");
    } else {
      // צופה שהוא בעל השיעור שהגיע דרך קישור השיתוף שלו עצמו
      const user = await getUser();
      if (user && meta.recordingId) initAiSection("trainee");
    }
  } catch (e) {
    /* צופה בלי פרופיל תפקידי, אין כפתור */
  }
}

// ---------- הניתוח החכם (פעימה 2) ----------

async function initAiSection(audience) {
  if (!analysisEnabled()) return;
  const btn = $("aiBtn");
  const status = $("aiStatus");
  btn.textContent =
    audience === "mentor" ? "ניתוח עמוק של השיעור" : "קבל משוב חכם על השיעור";
  show($("aiSection"), true);

  // הצגת התוצאה השמורה: המשוב שייך לדף השיעור ומופיע בו תמיד
  const renderSaved = async (row) => {
    const panel = $("aiPanel");
    if (audience === "mentor") {
      const rep = await getMentorReport(meta.recordingId);
      panel.innerHTML = renderMentorReport((rep && rep.report) || {}, rep && rep.mentor_note_draft);
      const copyBtn = panel.querySelector("#copyDraftBtn");
      if (copyBtn)
        copyBtn.onclick = async () => {
          await copyText(panel.querySelector("#mentorDraft").value);
          show(panel.querySelector("#copyDraftDone"), true);
        };
    } else {
      panel.innerHTML = renderTraineeFeedback((row && row.trainee_feedback) || {});
    }
    wireMoments(panel, $("player"));
    show(panel, true);
    show(status, false);
    btn.classList.add("hidden");
  };

  const labels = {
    transcribing: "מקשיבים לשיעור ומתמללים...",
    analyzing: "קוראים את השיעור לאור זרקורי המגדלור...",
    ready: "מוכן!",
  };

  const followRun = async () => {
    show(status, true);
    const row = await waitForAnalysis(meta.recordingId, (st) => {
      status.textContent = labels[st] || "עובדים על זה...";
    });
    await renderSaved(row);
  };

  // מצב פתיחה: משוב מוכן מוצג מיד; ריצה באמצע ממשיכה להתעדכן; כישלון מוסבר
  try {
    const row = await getAnalysis(meta.recordingId);
    if (row && row.status === "ready") {
      await renderSaved(row);
      return;
    }
    if (row && ["transcribing", "analyzing", "pending"].includes(row.status)) {
      btn.classList.add("hidden");
      await followRun();
      return;
    }
    if (row && row.status === "failed") {
      show(status, true);
      status.textContent =
        "הניתוח הקודם לא הצליח: " + (row.error || "סיבה לא ידועה") + ".";
      btn.textContent = "לנסות שוב";
    }
  } catch (e) {
    /* אין שורה עדיין, נשאר כפתור רגיל */
  }

  btn.onclick = async () => {
    btn.disabled = true;
    show(status, true);
    try {
      status.textContent =
        "מתחילים להקשיב לשיעור... זה לוקח כמה דקות, אפשר לסגור ולחזור מאוחר יותר.";
      await requestAnalysis(meta.recordingId);
      await followRun();
    } catch (e) {
      status.textContent = "משהו השתבש בניתוח: " + (e.message || e) + " אפשר לנסות שוב.";
      btn.disabled = false;
      btn.textContent = "לנסות שוב";
    }
  };
}

function showPlayer(src) {
  $("lessonTitle").textContent = meta.title || "שיעור";
  const parts = [];
  if (meta.ownerName) parts.push(meta.ownerName);
  if (meta.createdAt) parts.push(humanDate(meta.createdAt));
  if (meta.durationS) parts.push(humanMinutes(meta.durationS));
  $("lessonMeta").textContent = parts.join(" | ");
  goScreen("screen-player");

  const v = $("player");
  if (src) v.src = src;

  // קובצי webm של MediaRecorder עלולים להגיע בלי משך (duration=Infinity).
  // קפיצה לסוף מאלצת את הדפדפן לחשב את המשך, ואז חוזרים להתחלה.
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

  // זכירת נקודת עצירה
  const posKey = "migdalor_pos_" + (token || "rec_" + recId);
  const savedPos = parseFloat(localStorage.getItem(posKey) || "0");
  if (savedPos > 60) {
    $("resumeText").textContent = `הפסקת ${atMinute(savedPos)}, להמשיך משם?`;
    show($("resumeAsk"), true);
    $("resumeYes").onclick = () => {
      v.currentTime = savedPos;
      show($("resumeAsk"), false);
      v.play().catch(() => {});
    };
    $("resumeNo").onclick = () => {
      localStorage.removeItem(posKey);
      show($("resumeAsk"), false);
      v.play().catch(() => {});
    };
  }
  let watchedSeconds = 0;
  let lastT = 0;
  v.addEventListener("timeupdate", () => {
    if (v.currentTime > 10 && isFinite(v.currentTime)) {
      localStorage.setItem(posKey, String(Math.floor(v.currentTime)));
    }
    // צבירת זמן צפייה אמיתי לרישום "נצפה"
    const dt = v.currentTime - lastT;
    if (dt > 0 && dt < 2) watchedSeconds += dt;
    lastT = v.currentTime;
    if (!ownerMode && watchedSeconds > 30 && !viewRegistered) registerView();
  });
  v.addEventListener("ended", () => localStorage.removeItem(posKey));

  // דילוג ומהירות
  $("back15").onclick = () => (v.currentTime = Math.max(0, v.currentTime - 15));
  $("fwd15").onclick = () => (v.currentTime = v.currentTime + 15);
  $("speedBtn").onclick = () => {
    if (v.playbackRate === 1) {
      v.playbackRate = 1.5;
      $("speedBtn").textContent = "מהירות רגילה";
    } else {
      v.playbackRate = 1;
      $("speedBtn").textContent = "מהירות 1.5";
    }
  };

  $("myTraineesBtn").onclick = () =>
    (location.href = devHref(ownerMode ? "index.html" : "mentor.html"));

  v.addEventListener("error", () => {
    $("playerNote").textContent =
      "הסרטון לא נטען. זו כנראה בעיית תקשורת רגעית, מרעננים את הדף ומנסים שוב.";
  });
}

// רישום צפייה: אחרי חצי דקה של צפייה אמיתית, פעם אחת.
async function registerView() {
  viewRegistered = true;
  if (DEV) return;
  try {
    const jwt = await getAccessToken();
    await fetch(WORKER_URL + "/viewed", {
      method: "POST",
      headers: {
        authorization: "Bearer " + jwt,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
  } catch (e) {
    /* הרישום יקרה בצפייה הבאה */
  }
}

$("loginBtn").addEventListener("click", signInWithGoogle);
$("notReadyRetry").addEventListener("click", openLesson);
if (!DEV) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
      boot();
    }
  });
}
boot();
