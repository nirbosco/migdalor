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
  listRoster,
  upsertPerson,
  removeFromRoster,
} from "./supa.js";
import { $, show, goScreen, humanDate, watchOnline } from "./ui.js";
import { initDashShell, wireSort, closePanel } from "./dash-shell.js";

let parsed = null;
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

// ---------- טעינת CSV ----------

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const rows = [];
  const problems = [];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  lines.forEach((line, i) => {
    const cols = line.split(/\t|,/).map((c) => c.trim());
    // שורת כותרת: אין בה כתובת מייל
    if (i === 0 && !cols.some((c) => emailRe.test(c))) return;
    const [traineeEmail, traineeName, mentorEmail, mentorName, type] = cols;
    if (!emailRe.test(traineeEmail || "")) {
      problems.push(`שורה ${i + 1}: מייל החותמיסט לא תקין (${traineeEmail || "ריק"})`);
      return;
    }
    if (!emailRe.test(mentorEmail || "")) {
      problems.push(`שורה ${i + 1}: מייל המנטור לא תקין (${mentorEmail || "ריק"})`);
      return;
    }
    rows.push({
      traineeEmail: traineeEmail.toLowerCase(),
      traineeName: traineeName || "",
      mentorEmail: mentorEmail.toLowerCase(),
      mentorName: mentorName || "",
      type: type || "",
    });
  });
  return { rows, problems };
}

function wireCsv() {
  $("csvPreviewBtn").addEventListener("click", () => {
    show($("csvDone"), false);
    show($("csvError"), false);
    parsed = parseCsv($("csvBox").value);
    const trainees = new Set(parsed.rows.map((r) => r.traineeEmail));
    const mentorsSet = new Set(parsed.rows.map((r) => r.mentorEmail));
    $("csvSummary").textContent = parsed.rows.length
      ? `זיהינו ${trainees.size} חותמיסטים ו-${mentorsSet.size} מנטורים, ובסך הכול ${parsed.rows.length} שיבוצים.`
      : "לא זיהינו אף שורה תקינה. בודקים את סדר העמודות ומנסים שוב.";
    $("csvProblems").innerHTML = "";
    for (const p of parsed.problems) {
      const d = document.createElement("div");
      d.className = "notice";
      d.textContent = p + " (השורה תדולג, שאר השורות ייטענו)";
      $("csvProblems").appendChild(d);
    }
    show($("csvPreview"), true);
    $("csvCommitBtn").disabled = !parsed.rows.length;
  });

  $("csvCommitBtn").addEventListener("click", async () => {
    if (!parsed || !parsed.rows.length) return;
    $("csvCommitBtn").disabled = true;
    try {
      const roster = [];
      const seen = new Set();
      for (const r of parsed.rows) {
        if (!seen.has(r.traineeEmail)) {
          seen.add(r.traineeEmail);
          roster.push({ email: r.traineeEmail, full_name: r.traineeName, role: "trainee" });
        }
        if (!seen.has(r.mentorEmail)) {
          seen.add(r.mentorEmail);
          roster.push({ email: r.mentorEmail, full_name: r.mentorName, role: "mentor" });
        }
      }
      await upsertRosterRows(roster);
      const added = await addAssignments(
        parsed.rows.map((r) => ({
          trainee_email: r.traineeEmail,
          mentor_email: r.mentorEmail,
          assignment_type: r.type,
        }))
      );
      $("csvDone").textContent = `נטען. ${roster.length} אנשים ברשימה, ${added ?? parsed.rows.length} שיבוצים חדשים.`;
      show($("csvDone"), true);
      show($("csvPreview"), false);
      $("csvBox").value = "";
      await renderOverview();
      setTimeout(closePanel, 1400);
    } catch (e) {
      $("csvError").textContent = "הטעינה נכשלה: " + (e.message || e) + ". שום דבר חלקי לא נשמר בלי בדיקה, מנסים שוב.";
      show($("csvError"), true);
      $("csvCommitBtn").disabled = false;
    }
  });
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
wireCsv();
wireManual();
wireRoles();
boot();
