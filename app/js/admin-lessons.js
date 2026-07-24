// חותמטק: עמוד השיעורים. טבלת כל ההקלטות מסוג שיעור עם חיפוש, מיון,
// מסנן סטטוס ועימוד של 50 (כפתור "עוד"). לאדמין יש הרשאת הזרמה לכל
// הקלטה (דרך /mine ב-Worker), ולכן פעולת צפייה נפתחת בעמוד הצפייה הקיים.
// מחיקה משתמשת ב-deleteRecording הקיימת: מסד + קובץ בענן, בלתי הפיכה.

import { listAllRecordings, deleteRecording } from "./supa.js";
import { $, show, humanDate, humanMinutes } from "./ui.js";
import { wireSort } from "./dash-shell.js";
import { initAdminPage, navHref, esc, recordingStatusTag } from "./admin-shell.js";

const PAGE_SIZE = 50;

let loaded = [];      // כל השורות שנטענו עד עכשיו, עם מפתחות מיון
let total = 0;        // סך הכול במסד
let loading = false;

async function loadPage(reset) {
  if (loading) return;
  loading = true;
  show($("tableError"), false);
  if (reset) {
    loaded = [];
    total = 0;
    $("lessonCard").hidden = true;
    $("tableLoading").classList.remove("hidden");
  }
  $("moreBtn").disabled = true;
  let data;
  try {
    data = await listAllRecordings({ limit: PAGE_SIZE, offset: loaded.length });
  } catch (e) {
    $("tableLoading").classList.add("hidden");
    show($("tableError"), true);
    loading = false;
    $("moreBtn").disabled = false;
    return;
  }
  $("tableLoading").classList.add("hidden");
  total = data.total;
  loaded = loaded.concat(
    data.rows.map((r) => ({
      ...r,
      createdTs: r.created_at ? new Date(r.created_at).getTime() : 0,
    }))
  );
  loading = false;
  $("moreBtn").disabled = false;
  show($("tableEmpty"), !total);
  $("lessonCard").hidden = !total;
  renderRows(loaded);
}

function applyFilters(list) {
  const q = ($("lessonSearch").value || "").trim().toLowerCase();
  const status = $("statusFilter").value;
  return list.filter((r) => {
    if (status && r.status !== status) return false;
    if (!q) return true;
    return (
      (r.title || "").toLowerCase().includes(q) ||
      (r.ownerName || "").toLowerCase().includes(q) ||
      (r.ownerEmail || "").toLowerCase().includes(q)
    );
  });
}

function countText(filtered) {
  const shown = filtered.length;
  if (!shown) return "אין תוצאות";
  if (loaded.length < total) return `${shown} מתוך ${total} שיעורים`;
  return shown === 1 ? "שיעור אחד" : `${shown} שיעורים`;
}

function watchHref(r) {
  return navHref("watch.html?rec=" + encodeURIComponent(r.id));
}

function sharedText(r) {
  if (!r.sharedWith || !r.sharedWith.length) return "—";
  return r.sharedWith.join(", ");
}

function renderRows(list) {
  loaded = list;
  const filtered = applyFilters(list);
  $("lessonCount").textContent = countText(filtered);

  // דסקטופ
  const rows = $("lessonRows");
  rows.innerHTML = "";
  for (const r of filtered) {
    const row = document.createElement("tr");
    if (r.status === "failed") row.className = "flagged";
    row.innerHTML =
      `<td>${esc(r.title || "שיעור ללא שם")}</td>` +
      `<td>${esc(r.ownerName || r.ownerEmail || "")}</td>` +
      `<td>${esc(humanDate(r.created_at))}</td>` +
      `<td>${r.duration_s ? esc(humanMinutes(r.duration_s)) : "—"}</td>` +
      `<td>${recordingStatusTag(r.status)}</td>` +
      `<td>${esc(sharedText(r))}</td>` +
      `<td>${r.viewed ? `<span class="tag tag-ok">נצפה</span>` : "—"}</td>` +
      `<td>${r.hasAnalysis ? `<span class="tag tag-ok">יש</span>` : "—"}</td>` +
      `<td style="text-align:left; white-space:nowrap"></td>`;
    row.lastElementChild.append(...actionEls(r));
    rows.appendChild(row);
  }

  // מובייל
  const cards = $("lessonCards");
  cards.innerHTML = "";
  for (const r of filtered) {
    const card = document.createElement("div");
    card.className = "trow-card" + (r.status === "failed" ? " flagged" : "");
    card.innerHTML =
      `<div class="tc-head"><span class="tc-name">${esc(r.title || "שיעור ללא שם")}</span>${recordingStatusTag(r.status)}</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">חותמיסט</span><span class="v">${esc(r.ownerName || r.ownerEmail || "")}</span></div>` +
      `<div class="tc-field"><span class="k">תאריך</span><span class="v">${esc(humanDate(r.created_at))}</span></div>` +
      `<div class="tc-field"><span class="k">משך</span><span class="v">${r.duration_s ? esc(humanMinutes(r.duration_s)) : "—"}</span></div>` +
      `<div class="tc-field"><span class="k">שותף עם</span><span class="v">${esc(sharedText(r))}</span></div>` +
      `<div class="tc-field"><span class="k">נצפה</span><span class="v">${r.viewed ? "כן" : "עוד לא"}</span></div>` +
      `<div class="tc-field"><span class="k">ניתוח חכם</span><span class="v">${r.hasAnalysis ? "יש" : "אין"}</span></div>` +
      `</div>`;
    const actions = document.createElement("div");
    actions.className = "tc-actions";
    actions.append(...actionEls(r));
    card.appendChild(actions);
    cards.appendChild(card);
  }

  // כפתור "עוד" רק כשבאמת יש עוד, והחיפוש לא פעיל על חלק מהנתונים בלבד
  show($("moreWrap"), loaded.length < total);
  $("moreBtn").textContent = `עוד שיעורים (נטענו ${loaded.length} מתוך ${total})`;
}

function actionEls(r) {
  const els = [];
  if (r.status === "ready") {
    const view = document.createElement("a");
    view.className = "row-action";
    view.textContent = "לצפייה";
    view.href = watchHref(r);
    view.target = "_blank";
    view.rel = "noopener";
    view.style.textDecoration = "none";
    els.push(view);
  }
  const del = document.createElement("button");
  del.className = "row-action row-action-danger";
  del.textContent = "למחוק";
  del.addEventListener("click", async () => {
    const name = r.title || "שיעור ללא שם";
    const who = r.ownerName ? ` של ${r.ownerName}` : "";
    if (!confirm(`למחוק את "${name}"${who}? המחיקה מוחקת גם את הקובץ מהענן, ואי אפשר לבטל אותה.`)) return;
    del.disabled = true;
    try {
      await deleteRecording(r.id);
      loaded = loaded.filter((x) => x.id !== r.id);
      total = Math.max(0, total - 1);
      show($("tableEmpty"), !total);
      $("lessonCard").hidden = !total;
      renderRows(loaded);
    } catch (e) {
      del.disabled = false;
      alert("המחיקה נכשלה: " + (e.message || e));
    }
  });
  els.push(del);
  return els;
}

$("tableRetry").addEventListener("click", () => loadPage(true));
$("moreBtn").addEventListener("click", () => loadPage(false));
$("lessonSearch").addEventListener("input", () => renderRows(loaded));
$("statusFilter").addEventListener("change", () => renderRows(loaded));
wireSort(
  $("lessonTable"),
  () => loaded,
  (sorted) => renderRows(sorted)
);

initAdminPage({ page: "lessons", onReady: () => loadPage(true) });
