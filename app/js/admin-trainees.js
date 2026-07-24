// חותמטק: עמוד החותמיסטים. טבלה מלאה של כל החותמיסטים עם מובילי הבית
// והדעת שלהם, חיפוש חי, מיון בכל עמודה ומסנן לפי מוביל בית.
// לחיצה על שורה פותחת פירוט: השיעורים והשיבוצים של החותמיסט.

import { adminOverview, listAssignments, listRecordingsOfTrainee } from "./supa.js";
import { $, show, humanDate, humanMinutes } from "./ui.js";
import { wireSort } from "./dash-shell.js";
import { initAdminPage, navHref, esc, initials, traineeStatusTag, recordingStatusTag } from "./admin-shell.js";

let allTrainees = [];       // השורות המלאות, עם מפתחות מיון
let currentOrder = [];      // הסדר הנוכחי אחרי מיון
let openEmail = null;       // החותמיסט שהפירוט שלו פתוח
const detailCache = new Map(); // שיעורים שכבר נשלפו, כדי לא לשלוף פעמיים

const isDaat = (a) => (a.assignment_type || "").includes("דעת");

async function loadData() {
  show($("tableError"), false);
  $("tableLoading").classList.remove("hidden");
  $("traineeCard").hidden = true;
  let overview, assignments;
  try {
    [overview, assignments] = await Promise.all([adminOverview(), listAssignments()]);
  } catch (e) {
    $("tableLoading").classList.add("hidden");
    show($("tableError"), true);
    return;
  }
  $("tableLoading").classList.add("hidden");

  // חיבור השיבוצים לחותמיסטים: מוביל בית ומוביל דעת לכל אחד
  const byTrainee = new Map();
  for (const a of assignments) {
    if (!byTrainee.has(a.trainee_email)) byTrainee.set(a.trainee_email, []);
    byTrainee.get(a.trainee_email).push(a);
  }
  allTrainees = overview.trainees.map((t) => {
    const mine = byTrainee.get(t.email) || [];
    const house = mine.filter((a) => !isDaat(a));
    const daat = mine.filter(isDaat);
    const nameOf = (a) => a.mentor_name || a.mentor_email;
    return {
      ...t,
      lastRecordingTs: t.lastRecording ? new Date(t.lastRecording).getTime() : 0,
      houseNames: house.map(nameOf).join(", "),
      daatNames: daat.map(nameOf).join(", "),
      assignments: mine,
    };
  });
  allTrainees.sort((a, b) => b.lastRecordingTs - a.lastRecordingTs);
  currentOrder = allTrainees;

  // מסנן מוביל בית: כל מי שמופיע כמוביל בית בשיבוצים
  const mentorFilter = $("mentorFilter");
  const prev = mentorFilter.value;
  mentorFilter.innerHTML = `<option value="">כל מובילי הבית</option>`;
  const houseMentors = new Map();
  for (const a of assignments) {
    if (!isDaat(a)) houseMentors.set(a.mentor_email, a.mentor_name || a.mentor_email);
  }
  [...houseMentors.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "he"))
    .forEach(([email, name]) => {
      const o = document.createElement("option");
      o.value = email;
      o.textContent = name;
      mentorFilter.appendChild(o);
    });
  mentorFilter.value = prev || "";

  $("traineeCard").hidden = false;
  renderRows(currentOrder);
}

function applyFilters(list) {
  const q = ($("traineeSearch").value || "").trim().toLowerCase();
  const mentor = $("mentorFilter").value;
  return list.filter((t) => {
    if (mentor && !t.assignments.some((a) => !isDaat(a) && a.mentor_email === mentor)) return false;
    if (!q) return true;
    return (
      (t.full_name || "").toLowerCase().includes(q) ||
      (t.email || "").toLowerCase().includes(q) ||
      (t.houseNames || "").toLowerCase().includes(q) ||
      (t.daatNames || "").toLowerCase().includes(q)
    );
  });
}

function renderRows(list) {
  currentOrder = list;
  const filtered = applyFilters(list);
  $("traineeCount").textContent = filtered.length
    ? filtered.length === 1
      ? "חותמיסט אחד"
      : `${filtered.length} חותמיסטים`
    : "אין תוצאות";

  // דסקטופ
  const rows = $("traineeRows");
  rows.innerHTML = "";
  for (const t of filtered) {
    const row = document.createElement("tr");
    row.style.cursor = "pointer";
    if (!t.lastRecording) row.className = "flagged";
    if (t.email === openEmail) row.classList.add("row-open");
    row.innerHTML =
      `<td><div class="cell-name"><span class="avatar">${initials(t.full_name)}</span><span class="n">${esc(t.full_name)}<span class="sub-mail">${esc(t.email)}</span></span></div></td>` +
      `<td>${esc(t.houseNames || "—")}</td>` +
      `<td>${esc(t.daatNames || "—")}</td>` +
      `<td class="cell-num">${t.recordings || 0}</td>` +
      `<td>${t.lastRecording ? esc(humanDate(t.lastRecording)) : "עוד לא צילם"}</td>` +
      `<td class="cell-num">${t.shares || 0}</td>` +
      `<td class="cell-num">${t.viewed || 0}</td>` +
      `<td>${traineeStatusTag(t)}</td>`;
    row.addEventListener("click", () => toggleDetail(t));
    rows.appendChild(row);
    if (t.email === openEmail) {
      const detail = document.createElement("tr");
      detail.className = "detail-row";
      detail.innerHTML = `<td colspan="8"><div class="detail-cols" id="detailHolder"></div></td>`;
      rows.appendChild(detail);
      fillDetail(t, detail.querySelector("#detailHolder"));
    }
  }

  // מובייל
  const cards = $("traineeCards");
  cards.innerHTML = "";
  for (const t of filtered) {
    const card = document.createElement("div");
    card.className = "trow-card" + (t.lastRecording ? "" : " flagged");
    card.innerHTML =
      `<div class="tc-head"><span class="avatar">${initials(t.full_name)}</span><span class="tc-name">${esc(t.full_name)}</span>${traineeStatusTag(t)}</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">מוביל בית</span><span class="v">${esc(t.houseNames || "—")}</span></div>` +
      `<div class="tc-field"><span class="k">מוביל דעת</span><span class="v">${esc(t.daatNames || "—")}</span></div>` +
      `<div class="tc-field"><span class="k">שיעורים</span><span class="v">${t.recordings || 0}</span></div>` +
      `<div class="tc-field"><span class="k">אחרון</span><span class="v">${t.lastRecording ? esc(humanDate(t.lastRecording)) : "—"}</span></div>` +
      `<div class="tc-field"><span class="k">שיתופים</span><span class="v">${t.shares || 0}</span></div>` +
      `<div class="tc-field"><span class="k">נצפו</span><span class="v">${t.viewed || 0}</span></div>` +
      `</div>`;
    if (t.email === openEmail) {
      const holder = document.createElement("div");
      holder.className = "card-detail detail-cols";
      card.appendChild(holder);
      fillDetail(t, holder);
    }
    card.addEventListener("click", () => toggleDetail(t));
    cards.appendChild(card);
  }
}

function toggleDetail(t) {
  openEmail = openEmail === t.email ? null : t.email;
  renderRows(currentOrder);
}

// שורת הפירוט: השיעורים של החותמיסט (נשלפים פעם אחת) והשיבוצים שלו
async function fillDetail(t, holder) {
  const lessonsBox = document.createElement("div");
  lessonsBox.className = "detail-box";
  lessonsBox.innerHTML = `<h4>השיעורים של ${esc(t.full_name)}</h4><div class="skeleton"></div>`;
  const asgBox = document.createElement("div");
  asgBox.className = "detail-box";
  asgBox.innerHTML = `<h4>השיבוצים</h4>`;
  if (t.assignments.length) {
    for (const a of t.assignments) {
      const line = document.createElement("div");
      line.className = "detail-line";
      line.innerHTML =
        `<span class="grow">${esc(a.mentor_name || a.mentor_email)}<span class="sub-mail">${esc(a.mentor_email)}</span></span>` +
        `<span class="${isDaat(a) ? "tag" : "tag tag-ok"}">${esc(a.assignment_type || "מוביל בית")}</span>`;
      asgBox.appendChild(line);
    }
  } else {
    asgBox.insertAdjacentHTML("beforeend", `<div class="detail-empty">אין שיבוצים. משבצים בעמוד השיבוצים.</div>`);
  }
  holder.append(lessonsBox, asgBox);

  let recs = detailCache.get(t.email);
  if (!recs) {
    try {
      recs = await listRecordingsOfTrainee(t.email);
      detailCache.set(t.email, recs);
    } catch (e) {
      lessonsBox.innerHTML = `<h4>השיעורים של ${esc(t.full_name)}</h4><div class="detail-empty">לא הצלחנו להביא את השיעורים.</div>`;
      return;
    }
  }
  lessonsBox.innerHTML = `<h4>השיעורים של ${esc(t.full_name)}</h4>`;
  if (!recs.length) {
    lessonsBox.insertAdjacentHTML("beforeend", `<div class="detail-empty">עוד אין שיעורים.</div>`);
    return;
  }
  for (const r of recs) {
    const line = document.createElement("div");
    line.className = "detail-line";
    line.innerHTML =
      `<span class="grow">${esc(r.title || "שיעור ללא שם")}</span>` +
      `<span class="dim">${esc(humanDate(r.created_at))}${r.duration_s ? " | " + esc(humanMinutes(r.duration_s)) : ""}</span>` +
      recordingStatusTag(r.status) +
      (r.status === "ready"
        ? `<a class="row-action" href="${navHref("watch.html?rec=" + encodeURIComponent(r.id))}" target="_blank" rel="noopener">לצפייה</a>`
        : "");
    // לחיצה על קישור הצפייה לא סוגרת את הפירוט
    line.addEventListener("click", (e) => e.stopPropagation());
    lessonsBox.appendChild(line);
  }
}

$("tableRetry").addEventListener("click", loadData);
$("traineeSearch").addEventListener("input", () => renderRows(currentOrder));
$("mentorFilter").addEventListener("change", () => renderRows(currentOrder));
wireSort(
  $("traineeTable"),
  () => currentOrder,
  (sorted) => renderRows(sorted)
);

initAdminPage({ page: "trainees", onReady: loadData });
