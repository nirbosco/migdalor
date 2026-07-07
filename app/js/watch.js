// המגדלור: מסך הצפייה. דורש כניסת גוגל, וההרשאה נבדקת בשרת (ה-Worker):
// רק הנמען, הבעלים או אדמין רואים את הסרטון. הקישור עצמו לא סוד.

import { DEV, devHref, WORKER_URL, CONTACT_NAME, CONTACT_PHONE } from "./config.js";
import { supabase, getUser, getAccessToken, signInWithGoogle, getMyProfile } from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, atMinute, watchOnline } from "./ui.js";

const token = new URLSearchParams(location.search).get("token") || "";
let meta = null;
let viewRegistered = false;

async function boot() {
  if (DEV) document.body.classList.add("dev");
  watchOnline();

  if (!token) {
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
    return;
  }

  const jwt = await getAccessToken();
  let res;
  try {
    res = await fetch(WORKER_URL + "/meta?token=" + encodeURIComponent(token), {
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
  const src =
    WORKER_URL +
    "/v/" +
    encodeURIComponent(meta.recordingId) +
    "?token=" +
    encodeURIComponent(token) +
    "&auth=" +
    encodeURIComponent(jwt);
  showPlayer(src);

  // כפתור "כל החותמים שלי" למנטורים ואדמינים
  try {
    const profile = await getMyProfile();
    if (profile && (profile.role === "mentor" || profile.role === "admin")) {
      show($("myTraineesBtn"), true);
    }
  } catch (e) {
    /* צופה בלי פרופיל תפקידי, אין כפתור */
  }
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
  const posKey = "migdalor_pos_" + token;
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
    if (watchedSeconds > 30 && !viewRegistered) registerView();
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

  $("myTraineesBtn").onclick = () => (location.href = devHref("mentor.html"));

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
