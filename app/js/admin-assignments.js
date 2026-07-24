// חותמטק: עמוד השיבוצים. שלושה מדורים: טבלת כל השיבוצים (חיפוש, מסנן
// סוג ומוביל, הסרה עם אישור), שיבוץ ידני, וטעינת שיבוצים מקובץ.
// צינור הייבוא (תבנית / קובץ / גיליון גוגל / הדבקה + מסך בדיקה) עבר
// לכאן כמו שהוא מהפאנל הצדדי הישן של admin.js.

import { DEV } from "./config.js";
import {
  listAssignments,
  removeAssignment,
  upsertRosterRows,
  addAssignments,
  fetchSheetCsv,
} from "./supa.js";
import { $, show, humanDate } from "./ui.js";
import { wireSort } from "./dash-shell.js";
import { initAdminPage, esc } from "./admin-shell.js";

const isDaat = (a) => (a.assignment_type || "").includes("דעת");

let allAssignments = []; // כל השיבוצים עם מפתחות מיון

// ---------- טבלת השיבוצים ----------

async function loadAssignments() {
  show($("tableError"), false);
  $("tableLoading").classList.remove("hidden");
  $("asgCard").hidden = true;
  let rows;
  try {
    rows = await listAssignments();
  } catch (e) {
    $("tableLoading").classList.add("hidden");
    show($("tableError"), true);
    return;
  }
  $("tableLoading").classList.add("hidden");
  allAssignments = rows.map((a) => ({
    ...a,
    createdTs: a.created_at ? new Date(a.created_at).getTime() : 0,
  }));

  // מסנן מובילים: כל מי שמופיע בשיבוצים, ממוין בעברית
  const sel = $("asgMentorFilter");
  const prev = sel.value;
  sel.innerHTML = `<option value="">כל המובילים</option>`;
  const mentors = new Map();
  for (const a of allAssignments) {
    mentors.set(a.mentor_email, a.mentor_name || a.mentor_email);
  }
  [...mentors.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "he"))
    .forEach(([email, name]) => {
      const o = document.createElement("option");
      o.value = email;
      o.textContent = name;
      sel.appendChild(o);
    });
  sel.value = prev || "";

  show($("tableEmpty"), !allAssignments.length);
  $("asgCard").hidden = !allAssignments.length;
  renderRows(allAssignments);
}

function applyFilters(list) {
  const q = ($("asgSearch").value || "").trim().toLowerCase();
  const type = $("typeFilter").value;
  const mentor = $("asgMentorFilter").value;
  return list.filter((a) => {
    if (type === "house" && isDaat(a)) return false;
    if (type === "daat" && !isDaat(a)) return false;
    if (mentor && a.mentor_email !== mentor) return false;
    if (!q) return true;
    return (
      (a.trainee_name || "").toLowerCase().includes(q) ||
      (a.trainee_email || "").toLowerCase().includes(q) ||
      (a.mentor_name || "").toLowerCase().includes(q) ||
      (a.mentor_email || "").toLowerCase().includes(q)
    );
  });
}

function typeTag(a) {
  const label = a.assignment_type || "מוביל בית";
  return `<span class="${isDaat(a) ? "tag" : "tag tag-ok"}">${esc(label)}</span>`;
}

function renderRows(list) {
  allAssignments = list;
  const filtered = applyFilters(list);
  $("asgCount").textContent = filtered.length
    ? filtered.length === 1
      ? "שיבוץ אחד"
      : `${filtered.length} שיבוצים`
    : "אין תוצאות";

  // דסקטופ
  const rows = $("asgRows");
  rows.innerHTML = "";
  for (const a of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${esc(a.trainee_name || "—")}<span class="sub-mail">${esc(a.trainee_email)}</span></td>` +
      `<td>${esc(a.mentor_name || "—")}<span class="sub-mail">${esc(a.mentor_email)}</span></td>` +
      `<td>${typeTag(a)}</td>` +
      `<td>${a.created_at ? esc(humanDate(a.created_at)) : "—"}</td>` +
      `<td style="text-align:left"></td>`;
    tr.lastElementChild.appendChild(removeAsgBtn(a));
    rows.appendChild(tr);
  }

  // מובייל
  const cards = $("asgCards");
  cards.innerHTML = "";
  for (const a of filtered) {
    const card = document.createElement("div");
    card.className = "trow-card";
    card.innerHTML =
      `<div class="tc-head"><span class="tc-name">${esc(a.trainee_name || a.trainee_email)}</span>${typeTag(a)}</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">מוביל</span><span class="v">${esc(a.mentor_name || a.mentor_email)}</span></div>` +
      `<div class="tc-field"><span class="k">תאריך</span><span class="v">${a.created_at ? esc(humanDate(a.created_at)) : "—"}</span></div>` +
      `</div>`;
    const actions = document.createElement("div");
    actions.className = "tc-actions";
    actions.appendChild(removeAsgBtn(a));
    card.appendChild(actions);
    cards.appendChild(card);
  }
}

function removeAsgBtn(a) {
  const btn = document.createElement("button");
  btn.className = "row-action row-action-danger";
  btn.textContent = "להסיר";
  btn.addEventListener("click", async () => {
    const t = a.trainee_name || a.trainee_email;
    const m = a.mentor_name || a.mentor_email;
    if (!confirm(`להסיר את השיבוץ של ${t} אצל ${m}?`)) return;
    btn.disabled = true;
    try {
      await removeAssignment(a.id);
      allAssignments = allAssignments.filter((x) => x.id !== a.id);
      show($("tableEmpty"), !allAssignments.length);
      $("asgCard").hidden = !allAssignments.length;
      renderRows(allAssignments);
    } catch (e) {
      btn.disabled = false;
      alert("ההסרה נכשלה: " + (e.message || e));
    }
  });
  return btn;
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
      await loadAssignments();
    } catch (err) {
      $("manualError").textContent = "השיבוץ לא נשמר: " + (err.message || err);
      show($("manualError"), true);
    }
  });
}

// ---------- טעינת שיבוצים: תבנית, קובץ, גיליון גוגל והדבקה ----------
// ארבעת המסלולים נשפכים לאותו צינור: פירוק לטבלה -> נרמול עם בדיקה
// שורה-שורה -> מסך בדיקה -> טעינה של התקינות בלבד דרך המנגנון הקיים.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEMPLATE_HEADERS = [
  "מייל חותמיסט",
  "שם חותמיסט",
  "מייל מוביל בית",
  "שם מוביל בית",
  "סוג שיבוץ (לא חובה)",
];
// שורות הדוגמה בתבנית מסומנות כך, והייבוא מדלג עליהן אם נשכחו בפנים
const EXAMPLE_MARK = "(דוגמה)";

// השורות שעברו בדיקה ומחכות לאישור. כל מסלול מחליף את כולן.
let pendingRows = [];

// SheetJS נטען דינמית רק כשצריך אותו (תבנית או קובץ), לא בטעינת העמוד
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
  const isMentor = (h) => h.includes("מוביל") || h.includes("מנטור") || h.includes("mentor");
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
    else if (!r.mentorEmail) r.problem = "חסר מייל של מוביל בית";
    else if (!EMAIL_RE.test(r.mentorEmail)) r.problem = "מייל מוביל הבית לא תקין";
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
      `<div class="tc-field"><span class="k">מוביל בית</span><span class="v">${esc(r.mentorName || r.mentorEmail)}</span></div>` +
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
      ["israela@example.com", `ישראלה ישראלי ${EXAMPLE_MARK}`, "mentor@example.com", `ישראל ישראלי ${EXAMPLE_MARK}`, "מוביל בית"],
      ["israela@example.com", `ישראלה ישראלי ${EXAMPLE_MARK}`, "mentor2@example.com", `רות כהן ${EXAMPLE_MARK}`, "מוביל דעת"],
    ]);
    ws["!cols"] = [{ wch: 26 }, { wch: 22 }, { wch: 26 }, { wch: 22 }, { wch: 20 }];
    const help = XLSX.utils.aoa_to_sheet([
      ['ממלאים בגיליון "שיבוצים" שורה אחת לכל שיבוץ: חותמיסט ומוביל בית.'],
      ["אותו חותמיסט יכול להופיע בכמה שורות, עם מוביל בית אחר בכל שורה."],
      ['עמודת "סוג שיבוץ" לא חובה (למשל: מוביל בית, מוביל דעת).'],
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
    await loadAssignments();
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
  // מדור הייבוא תמיד גלוי בעמוד הזה, ולכן SheetJS נטען מראש כדי
  // שהתבנית והקובץ יגיבו מיד. במצב תצוגה לא נוגעים ברשת מראש.
  if (!DEV) loadXLSX().catch(() => {});
}

// ---------- חיווט העמוד ----------

$("tableRetry").addEventListener("click", loadAssignments);
$("asgSearch").addEventListener("input", () => renderRows(allAssignments));
$("typeFilter").addEventListener("change", () => renderRows(allAssignments));
$("asgMentorFilter").addEventListener("change", () => renderRows(allAssignments));
wireSort(
  $("asgTable"),
  () => allAssignments,
  (sorted) => renderRows(sorted)
);

initAdminPage({
  page: "assignments",
  onReady: async () => {
    wireManual();
    wireImport();
    await loadAssignments();
  },
});
