// חותמטק: פאנל האדמין. בנוי סביב "למי צריך לעזור היום", ורק אחר כך נתונים.
// נגיש לתפקיד admin בלבד; ההרשאה נאכפת ב-RLS, והמסך רק מכבד אותה.

import { DEV, devHref } from "./config.js";
import {
  supabase,
  getUser,
  signInWithGoogle,
  getMyProfile,
  adminOverview,
  upsertRosterRows,
  addAssignments,
  fetchSheetCsv,
  listRoster,
  upsertPerson,
  removeFromRoster,
  signOut,
} from "./supa.js";
import { $, show, goScreen, humanDate, watchOnline } from "./ui.js";
import { initDashShell, wireSort, closePanel } from "./dash-shell.js";

let currentTrainees = [];

// מציג את משטח הניהול (shell מסך-מלא) ומשחרר את רוחב ה-body.
// מסכי הכניסה נשארים ממורכזים (בלי dash).
function showAdminShell() {
  document.body.classList.add("dash");
  goScreen("screen-admin");
}
function showPlainScreen(id) {
  document.body.classList.remove("dash");
  goScreen(id);
}

async function boot() {
  if (DEV) document.body.classList.add("dev");
  initDashShell();
  watchOnline();

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
    $("deniedHome").href = devHref("index.html");
    showPlainScreen("screen-denied");
    return;
  }
  $("backToApp").href = devHref("index.html?stay=1");
  $("toMentor").href = devHref("mentor.html");
  showAdminShell();
  await renderOverview();
}

async function renderOverview() {
  show($("tableError"), false);
  $("helpLoading").classList.remove("hidden");
  $("tableLoading").classList.remove("hidden");
  let data;
  try {
    data = await adminOverview();
  } catch (e) {
    $("helpLoading").classList.add("hidden");
    $("tableLoading").classList.add("hidden");
    show($("tableError"), true);
    return;
  }
  $("helpLoading").classList.add("hidden");
  $("tableLoading").classList.add("hidden");

  // למי צריך לעזור היום
  $("joinRequests").innerHTML = "";
  $("failedUploads").innerHTML = "";
  const hasHelp = data.joinRequests.length || data.failedUploads.length;
  show($("helpEmpty"), !hasHelp);
  for (const jr of data.joinRequests) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = "";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = `${jr.full_name || "ללא שם"} מבקש להצטרף`;
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = `${jr.email} | ${jr.phone || "בלי טלפון"} | ${humanDate(jr.created_at)}`;
    const s = document.createElement("div");
    s.className = "status";
    s.textContent = "משבצים אותו בטופס הידני למטה, והכניסה הבאה שלו תעבוד.";
    card.append(t, m, s);
    $("joinRequests").appendChild(card);
  }
  for (const f of data.failedUploads) {
    const card = document.createElement("div");
    card.className = "card";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = `העלאה שלא הושלמה: ${f.title || "שיעור ללא שם"}`;
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = `${f.ownerEmail} | ${humanDate(f.created_at)} | מצב: ${f.status === "failed" ? "נכשלה" : "תקועה יותר מיום"}`;
    const s = document.createElement("div");
    s.className = "status";
    s.textContent = "כדאי להתקשר לחותמיסט: הסרטון שמור אצלו בטלפון, וכניסה מחודשת לאתר ממשיכה את ההעלאה.";
    card.append(t, m, s);
    $("failedUploads").appendChild(card);
  }

  // רצועת סיכום
  const totalTrainees = data.trainees.length;
  const totalShares = data.trainees.reduce((s, t) => s + (t.shares || 0), 0);
  const totalViewed = data.trainees.reduce((s, t) => s + (t.viewed || 0), 0);
  const helpCount = data.joinRequests.length + data.failedUploads.length;
  const viewedPct = totalShares ? Math.round((totalViewed / totalShares) * 100) : 0;
  $("statTrainees").textContent = totalTrainees;
  $("statShares").textContent = totalShares;
  $("statViewed").textContent = totalShares ? `${viewedPct}%` : "—";
  $("statHelp").textContent = helpCount;
  $("navTraineeCount").textContent = totalTrainees;
  $("navHelpCount").textContent = helpCount;

  // טבלת החותמיסטים: מכינים את הנתונים עם מפתחות מיון, ומרנדרים לשתי התצוגות
  currentTrainees = data.trainees.map((t) => ({
    ...t,
    lastRecordingTs: t.lastRecording ? new Date(t.lastRecording).getTime() : 0,
  }));
  // ברירת מחדל: החדש ביותר קודם (sorted-desc על ההקלטה האחרונה)
  currentTrainees.sort((a, b) => b.lastRecordingTs - a.lastRecordingTs);
  $("traineeCard").hidden = false;
  renderTraineeRows(currentTrainees);
}

// badge סטטוס לפי מצב החותמיסט
function statusTag(tr) {
  if (!tr.lastRecording) return `<span class="tag tag-stuck">עוד לא צילם</span>`;
  if ((tr.shares || 0) === 0) return `<span class="tag">צילם, לא שיתף</span>`;
  return `<span class="tag tag-ok">פעיל</span>`;
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/);
  return ((parts[0] || "").charAt(0) + (parts[1] || "").charAt(0)) || "?";
}

function renderTraineeRows(list) {
  const filtered = applySearch(list);
  // דסקטופ
  const rows = $("traineeRows");
  rows.innerHTML = "";
  for (const tr of filtered) {
    const row = document.createElement("tr");
    if (!tr.lastRecording) row.className = "flagged";
    row.innerHTML =
      `<td><div class="cell-name"><span class="avatar">${initials(tr.full_name)}</span><span class="n">${esc(tr.full_name)}</span></div></td>` +
      `<td>${tr.lastRecording ? esc(humanDate(tr.lastRecording)) : "עוד לא צילם"}</td>` +
      `<td class="cell-num">${tr.shares || 0}</td>` +
      `<td class="cell-num">${tr.viewed || 0}</td>` +
      `<td>${statusTag(tr)}</td>`;
    rows.appendChild(row);
  }
  // מובייל
  const cards = $("traineeCards");
  cards.innerHTML = "";
  for (const tr of filtered) {
    const card = document.createElement("div");
    card.className = "trow-card" + (tr.lastRecording ? "" : " flagged");
    card.innerHTML =
      `<div class="tc-head"><span class="avatar">${initials(tr.full_name)}</span><span class="tc-name">${esc(tr.full_name)}</span>${statusTag(tr)}</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">הקלטה אחרונה</span><span class="v">${tr.lastRecording ? esc(humanDate(tr.lastRecording)) : "—"}</span></div>` +
      `<div class="tc-field"><span class="k">שיתופים</span><span class="v">${tr.shares || 0}</span></div>` +
      `<div class="tc-field"><span class="k">נצפו</span><span class="v">${tr.viewed || 0}</span></div>` +
      `</div>`;
    cards.appendChild(card);
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function applySearch(list) {
  const q = ($("traineeSearch").value || "").trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (t) => (t.full_name || "").toLowerCase().includes(q) || (t.email || "").toLowerCase().includes(q)
  );
}

// ---------- טעינת שיבוצים: תבנית, קובץ, גיליון גוגל והדבקה ----------
// ארבעת המסלולים נשפכים לאותו צינור: פירוק לטבלה -> נרמול עם בדיקה
// שורה-שורה -> מסך בדיקה -> טעינה של התקינות בלבד דרך המנגנון הקיים.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE_HEADERS = [
  "מייל חותמיסט",
  "שם חותמיסט",
  "מייל מנטור",
  "שם מנטור",
  "סוג שיבוץ (לא חובה)",
];
// שורות הדוגמה בתבנית מסומנות כך, והייבוא מדלג עליהן אם נשכחו בפנים
const EXAMPLE_MARK = "(דוגמה)";

// השורות שעברו בדיקה ומחכות לאישור. כל מסלול מחליף את כולן.
let pendingRows = [];

// SheetJS נטען דינמית רק כשצריך אותו (תבנית או קובץ), לא בטעינת הפאנל
let xlsxPromise = null;
function loadXLSX() {
  if (!xlsxPromise) {
    xlsxPromise = import(
      "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs"
    ).catch((e) => {
      xlsxPromise = null;
      throw new Error("ספריית האקסל לא נטענה. בודקים חיבור לאינטרנט ומנסים שוב.");
    });
  }
  return xlsxPromise;
}

// פענוח CSV מלא (מרכאות, פסיק בתוך שדה, שורות מרובות) בלי תלות חיצונית,
// כדי שמסלול גוגל שיטס יעבוד גם במצב תצוגה בלי רשת.
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQ = false;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// הדבקה מאקסל מגיעה עם טאבים; הדבקה אחרת יכולה להיות CSV רגיל
function parsePaste(text) {
  const t = String(text || "");
  if (t.includes("\t")) {
    return t.split(/\r?\n/).map((line) => line.split("\t"));
  }
  return parseCsvText(t);
}

// זיהוי עמודות לפי שמות הכותרת, בלי תלות בסדר. מחזיר null אם לא זוהה.
function detectColumns(header) {
  const H = header.map((h) => String(h || "").toLowerCase());
  const isMail = (h) =>
    h.includes("מייל") || h.includes("אימייל") || h.includes("דוא") || h.includes("mail");
  const isName = (h) => h.includes("שם") || h.includes("name");
  const isTrainee = (h) => h.includes("חותמיסט") || h.includes("trainee");
  const isMentor = (h) => h.includes("מנטור") || h.includes("mentor");
  const find = (a, b) => H.findIndex((h) => a(h) && b(h));
  const te = find(isTrainee, isMail);
  const me = find(isMentor, isMail);
  if (te === -1 || me === -1) return null;
  return {
    te,
    tn: find(isTrainee, isName),
    me,
    mn: find(isMentor, isName),
    kind: H.findIndex((h) => h.includes("סוג") || h.includes("type")),
  };
}

// נרמול טבלה גולמית (מערך של שורות) לשורות שיבוץ עם בדיקה שורה-שורה.
// מדלג על שורות ריקות ועל שורות הדוגמה של התבנית; שורה בעייתית לא
// נזרקת אלא מסומנת בסיבה בעברית, כדי שתופיע במסך הבדיקה.
function normalizeTable(aoa) {
  const out = [];
  const clean = (aoa || []).map((r) => (r || []).map((c) => String(c ?? "").trim()));
  const firstIdx = clean.findIndex((r) => r.some(Boolean));
  if (firstIdx === -1) return out;

  // סדר קבוע כברירת מחדל; שורת כותרת (בלי מייל) מנסה זיהוי לפי שמות
  let cols = { te: 0, tn: 1, me: 2, mn: 3, kind: 4 };
  let start = firstIdx;
  const first = clean[firstIdx];
  if (!first.some((c) => EMAIL_RE.test(c))) {
    start = firstIdx + 1;
    cols = detectColumns(first) || cols;
  }

  const seen = new Set();
  for (let i = start; i < clean.length; i++) {
    const raw = clean[i];
    if (!raw.some(Boolean)) continue;
    if (raw.some((c) => c.includes(EXAMPLE_MARK))) continue;
    const pick = (idx) => (idx >= 0 ? raw[idx] || "" : "");
    const r = {
      line: i + 1,
      traineeEmail: pick(cols.te).toLowerCase(),
      traineeName: pick(cols.tn),
      mentorEmail: pick(cols.me).toLowerCase(),
      mentorName: pick(cols.mn),
      type: pick(cols.kind),
      problem: "",
    };
    if (!r.traineeEmail) r.problem = "חסר מייל של חותמיסט";
    else if (!EMAIL_RE.test(r.traineeEmail)) r.problem = "מייל החותמיסט לא תקין";
    else if (!r.mentorEmail) r.problem = "חסר מייל של מנטור";
    else if (!EMAIL_RE.test(r.mentorEmail)) r.problem = "מייל המנטור לא תקין";
    else {
      const key = r.traineeEmail + "|" + r.mentorEmail;
      if (seen.has(key)) r.problem = "שיבוץ כפול: הצמד הזה כבר מופיע למעלה";
      else seen.add(key);
    }
    out.push(r);
  }
  return out;
}

// חיווי עבודה: מנטרל את כפתורי המסלולים בזמן קריאה או משיכה
function importBusy(on) {
  show($("csvBusy"), on);
  for (const id of ["tplBtn", "xlsPickBtn", "sheetPullBtn", "csvPreviewBtn"]) {
    $(id).disabled = on;
  }
}

// ---- מסך הבדיקה לפני טעינה (משותף לכל המסלולים) ----

function renderPreview(rows) {
  pendingRows = rows;
  show($("csvDone"), false);
  show($("csvError"), false);
  const good = rows.filter((r) => !r.problem);
  const bad = rows.length - good.length;

  $("csvSummary").textContent = rows.length
    ? (good.length === 1 ? "שיבוץ אחד תקין" : `${good.length} שיבוצים תקינים`) +
      (bad ? `, ${bad === 1 ? "ושורה אחת עם בעיה שתדולג" : `ו-${bad} שורות עם בעיה שיידלגו`}.` : ".")
    : "לא זיהינו אף שורת שיבוץ. בודקים שממלאים לפי התבנית ומנסים שוב.";

  // דסקטופ: טבלה
  const body = $("previewRows");
  body.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    if (r.problem) tr.className = "row-bad";
    tr.innerHTML =
      `<td>${esc(r.traineeName || "—")}<span class="sub-mail">${esc(r.traineeEmail)}</span></td>` +
      `<td>${esc(r.mentorName || "—")}<span class="sub-mail">${esc(r.mentorEmail)}</span></td>` +
      `<td>${esc(r.type || "")}</td>` +
      `<td>${r.problem ? `<span class="row-reason">${esc(r.problem)}</span>` : `<span class="tag tag-ok">תקין</span>`}</td>`;
    body.appendChild(tr);
  }

  // מובייל: שורות-כרטיס
  const cards = $("previewCards");
  cards.innerHTML = "";
  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "trow-card" + (r.problem ? " row-bad" : "");
    card.innerHTML =
      `<div class="tc-head"><span class="tc-name">${esc(r.traineeName || r.traineeEmail)}</span>` +
      (r.problem ? "" : `<span class="tag tag-ok" style="margin-inline-start:auto">תקין</span>`) +
      `</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">מנטור</span><span class="v">${esc(r.mentorName || r.mentorEmail)}</span></div>` +
      `<div class="tc-field"><span class="k">סוג</span><span class="v">${esc(r.type || "—")}</span></div>` +
      `</div>` +
      (r.problem ? `<div class="row-reason" style="margin-top:8px">${esc(r.problem)}</div>` : "");
    cards.appendChild(card);
  }

  $("csvCommitBtn").textContent = good.length
    ? good.length === 1
      ? "לטעון שיבוץ אחד"
      : `לטעון ${good.length} שיבוצים`
    : "אין מה לטעון";
  $("csvCommitBtn").disabled = !good.length;
  show($("csvPreview"), true);
}

// ---- ארבעת המסלולים ----

// 1. הורדת תבנית: גיליון "שיבוצים" עם כותרות ושתי שורות דוגמה,
//    וגיליון "הוראות" קצר. נבנה בצד הלקוח עם SheetJS.
async function downloadTemplate() {
  show($("csvError"), false);
  importBusy(true);
  try {
    const XLSX = await loadXLSX();
    const ws = XLSX.utils.aoa_to_sheet([
      TEMPLATE_HEADERS,
      ["israela@example.com", `ישראלה ישראלי ${EXAMPLE_MARK}`, "mentor@example.com", `ישראל ישראלי ${EXAMPLE_MARK}`, "מורה מלווה"],
      ["israela@example.com", `ישראלה ישראלי ${EXAMPLE_MARK}`, "mentor2@example.com", `רות כהן ${EXAMPLE_MARK}`, "מוביל בית"],
    ]);
    ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 26 }, { wch: 22 }, { wch: 20 }];
    const help = XLSX.utils.aoa_to_sheet([
      ['ממלאים בגיליון "שיבוצים" שורה אחת לכל שיבוץ: חותמיסט ומנטור.'],
      ["אותו חותמיסט יכול להופיע בכמה שורות, עם מנטור אחר בכל שורה."],
      ['עמודת "סוג שיבוץ" לא חובה (למשל: מורה מלווה, מוביל בית).'],
      ["מוחקים את שתי שורות הדוגמה לפני הטעינה."],
    ]);
    help["!cols"] = [{ wch: 70 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "שיבוצים");
    XLSX.utils.book_append_sheet(wb, help, "הוראות");
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.writeFile(wb, "תבנית-שיבוצים-חותמטק.xlsx");
  } catch (e) {
    $("csvError").textContent = "הורדת התבנית נכשלה: " + (e.message || e);
    show($("csvError"), true);
  }
  importBusy(false);
}

// 2. קובץ מהמחשב: xlsx/xls דרך SheetJS, csv דרך הפענוח המקומי (UTF-8)
async function handleFile(file) {
  if (!file) return;
  show($("csvError"), false);
  show($("csvPreview"), false);
  importBusy(true);
  try {
    let aoa;
    if (/\.csv$/i.test(file.name)) {
      aoa = parseCsvText(await file.text());
    } else {
      const XLSX = await loadXLSX();
      const wb = XLSX.read(await file.arrayBuffer());
      const name = wb.SheetNames.includes("שיבוצים") ? "שיבוצים" : wb.SheetNames[0];
      aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: false });
    }
    renderPreview(normalizeTable(aoa));
  } catch (e) {
    $("csvError").textContent = "לא הצלחנו לקרוא את הקובץ: " + (e.message || e);
    show($("csvError"), true);
  }
  importBusy(false);
  $("xlsFile").value = "";
}

// 3. גיליון גוגל: מחלצים מזהה מהקישור ומושכים CSV דרך ה-Worker
function parseSheetLink(link) {
  const t = String(link || "").trim();
  const m = t.match(/\/d\/([A-Za-z0-9_-]{10,})/);
  let id = m ? m[1] : null;
  // הודבק המזהה עצמו במקום קישור מלא? גם זה עובד
  if (!id && /^[A-Za-z0-9_-]{10,}$/.test(t)) id = t;
  const g = t.match(/[?&#]gid=(\d{1,12})/);
  return { id, gid: g ? g[1] : "0" };
}

async function pullSheet() {
  show($("csvError"), false);
  show($("csvDone"), false);
  const { id, gid } = parseSheetLink($("sheetUrl").value);
  if (!id) {
    $("csvError").textContent =
      "לא זיהינו קישור לגיליון גוגל. מעתיקים את הכתובת המלאה משורת הכתובת של הדפדפן ומדביקים כאן.";
    show($("csvError"), true);
    return;
  }
  show($("csvPreview"), false);
  importBusy(true);
  try {
    const csv = await fetchSheetCsv(id, gid);
    renderPreview(normalizeTable(parseCsvText(csv)));
  } catch (e) {
    $("csvError").textContent = e.message || String(e);
    show($("csvError"), true);
  }
  importBusy(false);
}

// ---- הטעינה עצמה: רק השורות התקינות, דרך המנגנון הקיים ----

async function commitRows() {
  const good = pendingRows.filter((r) => !r.problem);
  if (!good.length) return;
  $("csvCommitBtn").disabled = true;
  show($("csvError"), false);
  try {
    const roster = [];
    const byEmail = new Map();
    const addPerson = (email, name, role) => {
      if (!byEmail.has(email)) {
        const row = { email, full_name: name || "", role };
        byEmail.set(email, row);
        roster.push(row);
      } else if (name && !byEmail.get(email).full_name) {
        byEmail.get(email).full_name = name;
      }
    };
    for (const r of good) {
      addPerson(r.traineeEmail, r.traineeName, "trainee");
      addPerson(r.mentorEmail, r.mentorName, "mentor");
    }
    await upsertRosterRows(roster);
    const added = await addAssignments(
      good.map((r) => ({
        trainee_email: r.traineeEmail,
        mentor_email: r.mentorEmail,
        assignment_type: r.type,
      }))
    );
    $("csvDone").textContent = `נטען. ${roster.length} אנשים ברשימה, ${added ?? good.length} שיבוצים חדשים.`;
    show($("csvDone"), true);
    show($("csvPreview"), false);
    $("csvBox").value = "";
    pendingRows = [];
    await renderOverview();
    setTimeout(closePanel, 1600);
  } catch (e) {
    $("csvError").textContent =
      "הטעינה נכשלה: " + (e.message || e) + ". שום דבר חלקי לא נשמר בלי בדיקה, מנסים שוב.";
    show($("csvError"), true);
    $("csvCommitBtn").disabled = false;
  }
}

function wireImport() {
  $("tplBtn").addEventListener("click", downloadTemplate);
  $("xlsPickBtn").addEventListener("click", () => $("xlsFile").click());
  $("xlsFile").addEventListener("change", () => handleFile($("xlsFile").files[0]));
  $("sheetPullBtn").addEventListener("click", pullSheet);
  $("sheetUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      pullSheet();
    }
  });
  $("csvPreviewBtn").addEventListener("click", () => {
    renderPreview(normalizeTable(parsePaste($("csvBox").value)));
  });
  $("csvCommitBtn").addEventListener("click", commitRows);
  // פתיחת החלונית מטעינה את SheetJS מראש, כדי שהתבנית והקובץ יגיבו מיד.
  // במצב תצוגה לא נוגעים ברשת מראש; הטעינה תקרה רק אם באמת בוחרים קובץ.
  document.querySelectorAll("[onclick*=\"csvPanel\"]").forEach((el) =>
    el.addEventListener("click", () => {
      if (!DEV) loadXLSX().catch(() => {});
    })
  );
}

// ---------- שיבוץ ידני ----------

function wireManual() {
  $("manualForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("manualDone"), false);
    show($("manualError"), false);
    const traineeEmail = $("mTraineeEmail").value.trim().toLowerCase();
    const mentorEmail = $("mMentorEmail").value.trim().toLowerCase();
    try {
      await upsertRosterRows([
        { email: traineeEmail, full_name: $("mTraineeName").value.trim(), role: "trainee" },
        { email: mentorEmail, full_name: $("mMentorName").value.trim(), role: "mentor" },
      ]);
      await addAssignments([
        {
          trainee_email: traineeEmail,
          mentor_email: mentorEmail,
          assignment_type: $("mType").value.trim(),
        },
      ]);
      $("manualDone").textContent = "השיבוץ נשמר. הכניסה הבאה של שניהם תעבוד כרגיל.";
      show($("manualDone"), true);
      $("manualForm").reset();
      await renderOverview();
      setTimeout(closePanel, 1400);
    } catch (err) {
      $("manualError").textContent = "השיבוץ לא נשמר: " + (err.message || err);
      show($("manualError"), true);
    }
  });
}

// ---------- ניהול תפקידים ----------

const ROLE_LABEL = { trainee: "חותמיסט", mentor: "מנטור", admin: "אדמין" };
const ROLE_TAG = { trainee: "tag", mentor: "tag tag-ok", admin: "badge-new" };

async function renderRoster() {
  show($("rosterError"), false);
  $("rosterLoading").classList.remove("hidden");
  $("rosterCard").hidden = true;
  let roster;
  try {
    roster = await listRoster();
  } catch (e) {
    $("rosterLoading").classList.add("hidden");
    show($("rosterError"), true);
    return;
  }
  $("rosterLoading").classList.add("hidden");
  roster.sort(
    (a, b) =>
      (a.role || "").localeCompare(b.role || "") ||
      (a.full_name || "").localeCompare(b.full_name || "", "he")
  );
  $("rosterCard").hidden = false;

  // דסקטופ
  const rows = $("rosterRows");
  rows.innerHTML = "";
  for (const p of roster) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td style="direction:ltr; text-align:right">${esc(p.email)}</td>` +
      `<td>${esc(p.full_name || "")}</td>` +
      `<td></td><td style="text-align:left"></td>`;
    tr.children[2].appendChild(roleSelect(p));
    tr.children[3].appendChild(removeBtn(p));
    rows.appendChild(tr);
  }

  // מובייל
  const cards = $("rosterCards");
  cards.innerHTML = "";
  for (const p of roster) {
    const card = document.createElement("div");
    card.className = "trow-card";
    const head = document.createElement("div");
    head.className = "tc-head";
    head.innerHTML = `<span class="tc-name">${esc(p.full_name || p.email)}</span><span class="${ROLE_TAG[p.role] || "tag"}" style="margin-inline-start:auto">${ROLE_LABEL[p.role] || p.role}</span>`;
    const grid = document.createElement("div");
    grid.className = "tc-grid";
    const f1 = document.createElement("div");
    f1.className = "tc-field";
    f1.innerHTML = `<span class="k">מייל</span><span class="v" style="direction:ltr">${esc(p.email)}</span>`;
    const f2 = document.createElement("div");
    f2.className = "tc-field";
    f2.innerHTML = `<span class="k">תפקיד</span>`;
    f2.appendChild(roleSelect(p));
    grid.append(f1, f2);
    card.append(head, grid, removeBtn(p, true));
    cards.appendChild(card);
  }
}

function roleSelect(p) {
  const sel = document.createElement("select");
  sel.style.margin = "0";
  sel.style.minHeight = "38px";
  for (const r of ["trainee", "mentor", "admin"]) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = ROLE_LABEL[r];
    if (p.role === r) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", async () => {
    sel.disabled = true;
    try {
      await upsertPerson({ email: p.email, full_name: p.full_name, role: sel.value });
      p.role = sel.value;
    } catch (e) {
      sel.value = p.role;
      alert("העדכון לא נשמר: " + (e.message || e));
    }
    sel.disabled = false;
  });
  return sel;
}

function removeBtn(p, block) {
  const btn = document.createElement("button");
  btn.className = "row-action";
  btn.textContent = "להסיר";
  btn.style.color = "var(--adom)";
  if (block) { btn.style.marginTop = "10px"; }
  btn.addEventListener("click", async () => {
    if (!confirm(`להסיר את ${p.full_name || p.email} מהרשימה?`)) return;
    btn.disabled = true;
    try {
      await removeFromRoster(p.email);
      await renderRoster();
    } catch (e) {
      btn.disabled = false;
      alert("ההסרה נכשלה: " + (e.message || e));
    }
  });
  return btn;
}

function wireRoles() {
  $("roleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("roleDone"), false);
    show($("roleError"), false);
    const email = $("roleEmail").value.trim().toLowerCase();
    const full_name = $("roleName").value.trim();
    const role = $("roleSelect").value;
    try {
      await upsertPerson({ email, full_name, role });
      $("roleDone").textContent = `${full_name || email} נשמר כ${ROLE_LABEL[role]}.`;
      show($("roleDone"), true);
      $("roleForm").reset();
      await renderRoster();
    } catch (err) {
      $("roleError").textContent = "השמירה נכשלה: " + (err.message || err);
      show($("roleError"), true);
    }
  });
  // טעינת הרשימה בפתיחת הפאנל
  document
    .querySelectorAll('[onclick="openPanel(\'rolesPanel\')"]')
    .forEach((el) => el.addEventListener("click", renderRoster));
}

$("loginBtn").addEventListener("click", signInWithGoogle);
$("tableRetry").addEventListener("click", renderOverview);
$("traineeSearch").addEventListener("input", () => renderTraineeRows(currentTrainees));
wireSort(
  $("traineeTable"),
  () => currentTrainees,
  (sorted) => {
    currentTrainees = sorted;
    renderTraineeRows(currentTrainees);
  }
);
if (!DEV) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
      boot();
    }
  });
}
wireImport();
wireManual();
wireRoles();
// התנתקות: חוזרים למסך הכניסה נקיים
const _lo = document.getElementById("logoutLink");
if (_lo) _lo.addEventListener("click", async (e) => {
  e.preventDefault();
  try { await signOut(); } catch (err) { /* גם אם נכשל, מנקים מקומית */ }
  location.replace("index.html");
});

boot();
