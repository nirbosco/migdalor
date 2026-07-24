// חותמטק: השכבה המשותפת של עמודי הניהול.
// כל עמוד אדמין (דשבורד, חותמיסטים, שיעורים, שיבוצים, משתמשים) נשען עליה:
// היא מזריקה את מסכי הכניסה, בונה את סרגל הצד האחיד עם הפריט הפעיל,
// בודקת הרשאת אדמין (הנאכפת ממילא ב-RLS) ומספקת עזרי תצוגה משותפים.

import { DEV } from "./config.js";
import {
  supabase,
  getUser,
  getMyProfile,
  signInWithGoogle,
  signInWithEmailOtp,
  signOut,
} from "./supa.js";
import { $, show, goScreen, watchOnline } from "./ui.js";
import { initDashShell } from "./dash-shell.js";

// ---------- קישורים ששומרים על מצב התצוגה ----------
// במצב ?dev=1 (ולפעמים גם ?role=admin) הפרמטרים חייבים לעבור בין העמודים,
// אחרת המעבר הראשון מנתק את ההדגמה.
export function navHref(href) {
  if (!DEV) return href;
  const cur = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (cur.has("dev")) keep.set("dev", cur.get("dev") || "1");
  if (cur.has("role")) keep.set("role", cur.get("role"));
  const q = keep.toString();
  if (!q) return href;
  return href + (href.includes("?") ? "&" : "?") + q;
}

// ---------- הניווט האחיד ----------

const NAV_MAIN = [
  { id: "dashboard", href: "admin.html", label: "דשבורד", icon: "i-lighthouse" },
  { id: "trainees", href: "admin-trainees.html", label: "חותמיסטים", icon: "i-profile" },
  { id: "lessons", href: "admin-lessons.html", label: "שיעורים", icon: "i-eye" },
  { id: "assignments", href: "admin-assignments.html", label: "שיבוצים", icon: "i-calendar" },
  { id: "users", href: "admin-users.html", label: "משתמשים", icon: "i-handshake" },
];

const NAV_FOOT = [
  { href: "index.html?stay=1", label: "למסך הצילום", icon: "i-telescope" },
  { href: "mentor.html", label: "למסך מוביל הבית", icon: "i-eye" },
  { href: "sim.html", label: "מרכז הסימולציות", icon: "i-clock" },
];

function navItemHtml(item, active) {
  return (
    `<a class="nav-item${active ? " active" : ""}" href="${navHref(item.href)}">` +
    `<span class="ico"><svg><use href="#${item.icon}"/></svg></span>${item.label}</a>`
  );
}

function buildSidebar(activeId) {
  const aside = document.getElementById("adminSidebar");
  if (!aside) return;
  aside.innerHTML =
    `<div class="sidebar-brand">` +
    `<span class="brand-icon"><svg><use href="#i-lighthouse"/></svg></span>` +
    `<span class="name">חותמטק</span></div>` +
    NAV_MAIN.map((n) => navItemHtml(n, n.id === activeId)).join("") +
    `<div class="sidebar-foot">` +
    NAV_FOOT.map((n) => navItemHtml(n, false)).join("") +
    `<a id="logoutLink" class="nav-item" href="#">` +
    `<span class="ico"><svg><use href="#i-share"/></svg></span>התנתקות</a>` +
    // חתימת המותג: הלוגו הצבעוני של חותם, עם שקט מסביב
    `<img src="assets/hotam-color.png" alt="חותם"` +
    ` style="width:120px;height:auto;display:block;margin:22px auto 10px">` +
    `</div>`;
  $("logoutLink").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await signOut();
    } catch (err) {
      /* גם אם נכשל, עוזבים את העמוד נקיים */
    }
    location.replace("index.html");
  });
}

// ---------- מסכי כניסה ודחייה (מקור אחד לכל העמודים) ----------

const AUTH_SCREENS = `
<section id="screen-boot" class="screen active">
  <h1>חותמטק</h1>
  <p class="small mt">רק רגע...</p>
</section>

<section id="screen-login" class="screen">
  <h1>פאנל ניהול</h1>
  <div class="notice plain mt">
    עכשיו יופיע מסך של גוגל. בוחרים את החשבון שלך ולוחצים אישור.
  </div>
  <button id="loginBtn" class="btn-primary">כניסה עם Google</button>
  <div class="login-divider">או</div>
  <button id="otpOpenBtn" class="btn-secondary">כניסה עם מייל ארגוני (TFI)</button>
  <form id="otpForm" class="hidden">
    <label for="otpEmail">המייל הארגוני</label>
    <input type="email" id="otpEmail" autocomplete="email" required>
    <button type="submit" id="otpSendBtn" class="btn-primary">לשלוח לי קישור כניסה</button>
  </form>
  <div id="otpDone" class="notice ok hidden">שלחנו קישור כניסה למייל. פותחים אותו מהמכשיר הזה.</div>
  <div id="otpError" class="notice hidden"></div>
</section>

<section id="screen-denied" class="screen">
  <h1>העמוד הזה מיועד לצוות המלווה</h1>
  <p class="mt">פאנל הניהול פתוח למובילי ההכשרה בלבד. השיעורים שלך מחכים לך בעמוד האישי שלך, ואם לדעתך זו טעות, פונים לצוות.</p>
  <a id="deniedHome" href="index.html" class="btn-primary" style="display:flex; align-items:center; justify-content:center; text-decoration:none">לעמוד שלי</a>
</section>`;

function injectAuthScreens() {
  const holder = document.getElementById("authScreens");
  if (holder) holder.innerHTML = AUTH_SCREENS;
}

// כניסה במייל ארגוני (TFI): קישור קסם למייל. שגיאות מוסברות בעברית.
function otpErrorText(err) {
  const msg = String((err && err.message) || err || "");
  if ((err && err.status === 429) || /rate ?limit|too many|429/i.test(msg))
    return "יותר מדי ניסיונות, המתינו כמה דקות ומנסים שוב.";
  if (/invalid|valid email|unable to validate/i.test(msg))
    return "כתובת המייל לא נראית תקינה. בודקים אותה ומנסים שוב.";
  return "שליחת הקישור לא הצליחה כרגע. מנסים שוב בעוד רגע.";
}

function wireAuthUi() {
  $("loginBtn").addEventListener("click", signInWithGoogle);
  const open = $("otpOpenBtn");
  open.addEventListener("click", () => {
    show(open, false);
    show($("otpForm"), true);
    $("otpEmail").focus();
  });
  $("otpForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("otpDone"), false);
    show($("otpError"), false);
    $("otpSendBtn").disabled = true;
    try {
      await signInWithEmailOtp($("otpEmail").value);
      show($("otpDone"), true);
    } catch (err) {
      $("otpError").textContent = otpErrorText(err);
      show($("otpError"), true);
    }
    $("otpSendBtn").disabled = false;
  });
}

// ---------- מעבר בין מסכי כניסה למשטח הניהול ----------

function showAdminShell() {
  document.body.classList.add("dash");
  goScreen("screen-admin");
}
function showPlainScreen(id) {
  document.body.classList.remove("dash");
  goScreen(id);
}

// ---------- נקודת הכניסה של כל עמוד ניהול ----------
// initAdminPage({ page: "lessons", onReady: async (profile) => {...} })
// מחזירה רק אחרי שהמשתמש אומת כאדמין ו-onReady הסתיים (או שהוצג מסך אחר).

export async function initAdminPage({ page, onReady }) {
  if (DEV) document.body.classList.add("dev");
  injectAuthScreens();
  initDashShell();
  buildSidebar(page);
  wireAuthUi();
  watchOnline();

  const boot = async () => {
    const user = await getUser();
    if (!user) {
      showPlainScreen("screen-login");
      return;
    }
    let profile = null;
    try {
      profile = await getMyProfile();
    } catch (e) {
      /* ייחסם למטה */
    }
    if (!profile || profile.role !== "admin") {
      $("deniedHome").href = navHref("index.html");
      showPlainScreen("screen-denied");
      return;
    }
    const avatar = document.getElementById("topbarAvatar");
    if (avatar) avatar.textContent = initials(profile.full_name || profile.email).charAt(0);
    showAdminShell();
    if (onReady) await onReady(profile);
  };

  if (!DEV) {
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
        boot();
      }
    });
  }
  await boot();
}

// ---------- עזרי תצוגה משותפים ----------

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

export function initials(name) {
  const parts = (name || "").trim().split(/\s+/);
  return ((parts[0] || "").charAt(0) + (parts[1] || "").charAt(0)) || "?";
}

// badge סטטוס לפי מצב החותמיסט (דשבורד + עמוד החותמיסטים)
export function traineeStatusTag(tr) {
  if (!tr.lastRecording) return `<span class="tag tag-stuck">עוד לא צילם</span>`;
  if ((tr.shares || 0) === 0) return `<span class="tag">צילם, לא שיתף</span>`;
  return `<span class="tag tag-ok">פעיל</span>`;
}

// badge סטטוס להקלטה (דשבורד + עמוד השיעורים)
export function recordingStatusTag(status) {
  if (status === "ready") return `<span class="tag tag-ok">מוכן</span>`;
  if (status === "failed") return `<span class="tag tag-stuck">נכשל</span>`;
  return `<span class="tag">בהעלאה</span>`;
}

// תוויות תפקיד לתצוגה. ערכי ה-DB נשארים trainee/mentor/admin.
export const ROLE_LABEL = { trainee: "חותמיסט/ית", mentor: "מוביל/ת בית", admin: "אדמין" };
export const ROLE_TAG = { trainee: "tag", mentor: "tag tag-ok", admin: "badge-new" };
