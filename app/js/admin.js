// חותמטק: דשבורד הניהול. מבט-על בלבד: רצועת סיכום, "למי צריך לעזור היום"
// ופעילות אחרונה. הטבלאות המלאות והפעולות עברו לעמודים הייעודיים
// (חותמיסטים, שיעורים, שיבוצים, משתמשים), והשכבה המשותפת ב-admin-shell.js.

import { adminOverview, listAllRecordings } from "./supa.js";
import { $, show, humanDate, humanMinutes } from "./ui.js";
import { initAdminPage, navHref, esc, recordingStatusTag } from "./admin-shell.js";

async function renderOverview() {
  $("helpLoading").classList.remove("hidden");
  let data;
  try {
    data = await adminOverview();
  } catch (e) {
    $("helpLoading").classList.add("hidden");
    return;
  }
  $("helpLoading").classList.add("hidden");

  // למי צריך לעזור היום
  $("joinRequests").innerHTML = "";
  $("failedUploads").innerHTML = "";
  const hasHelp = data.joinRequests.length || data.failedUploads.length;
  show($("helpEmpty"), !hasHelp);
  for (const jr of data.joinRequests) {
    const card = document.createElement("div");
    card.className = "card";
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = `${jr.full_name || "ללא שם"} מבקש להצטרף`;
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = `${jr.email} | ${jr.phone || "בלי טלפון"} | ${humanDate(jr.created_at)}`;
    const s = document.createElement("div");
    s.className = "status";
    s.innerHTML =
      `משבצים אותו בעמוד <a href="${navHref("admin-assignments.html")}">השיבוצים</a>, והכניסה הבאה שלו תעבוד.`;
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
    s.textContent =
      "כדאי להתקשר לחותמיסט: הסרטון שמור אצלו בטלפון, וכניסה מחודשת לאתר ממשיכה את ההעלאה.";
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
}

// פעילות אחרונה: עשרת השיעורים האחרונים, בלי פעולות. הפירוט בעמוד השיעורים.
async function renderRecent() {
  show($("recentError"), false);
  $("recentLoading").classList.remove("hidden");
  let data;
  try {
    data = await listAllRecordings({ limit: 10, offset: 0 });
  } catch (e) {
    $("recentLoading").classList.add("hidden");
    show($("recentError"), true);
    return;
  }
  $("recentLoading").classList.add("hidden");
  const rows = data.rows;
  show($("recentEmpty"), !rows.length);
  $("recentCard").hidden = !rows.length;
  if (!rows.length) return;

  // דסקטופ
  const body = $("recentRows");
  body.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${esc(r.title || "שיעור ללא שם")}</td>` +
      `<td>${esc(r.ownerName || r.ownerEmail || "")}</td>` +
      `<td>${esc(humanDate(r.created_at))}</td>` +
      `<td>${r.duration_s ? esc(humanMinutes(r.duration_s)) : "—"}</td>` +
      `<td>${recordingStatusTag(r.status)}</td>`;
    body.appendChild(tr);
  }

  // מובייל
  const cards = $("recentCards");
  cards.innerHTML = "";
  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "trow-card";
    card.innerHTML =
      `<div class="tc-head"><span class="tc-name">${esc(r.title || "שיעור ללא שם")}</span>${recordingStatusTag(r.status)}</div>` +
      `<div class="tc-grid">` +
      `<div class="tc-field"><span class="k">חותמיסט</span><span class="v">${esc(r.ownerName || r.ownerEmail || "")}</span></div>` +
      `<div class="tc-field"><span class="k">תאריך</span><span class="v">${esc(humanDate(r.created_at))}</span></div>` +
      `<div class="tc-field"><span class="k">משך</span><span class="v">${r.duration_s ? esc(humanMinutes(r.duration_s)) : "—"}</span></div>` +
      `</div>`;
    cards.appendChild(card);
  }
}

// קישורי הכרטיסים והמדורים שומרים על מצב התצוגה (?dev=1)
function wireLinks() {
  $("statCardTrainees").href = navHref("admin-trainees.html");
  $("statCardShares").href = navHref("admin-lessons.html");
  $("statCardViewed").href = navHref("admin-lessons.html");
  $("allLessonsLink").href = navHref("admin-lessons.html");
}

$("recentRetry").addEventListener("click", renderRecent);

initAdminPage({
  page: "dashboard",
  onReady: async () => {
    wireLinks();
    await Promise.all([renderOverview(), renderRecent()]);
  },
});
