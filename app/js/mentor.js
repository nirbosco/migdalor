// חותמטק: המסך של המנטור. כל מה ששותף איתי, מקובץ לפי חותם,
// ממוין מהחדש לישן, עם סימון "חדש" על מה שטרם נצפה.
// מעוצב כמשטח דשבורדי: shell + טבלה לכל חותם + גרסת מובייל.

import { DEV, devHref } from "./config.js";
import { supabase, getUser, signInWithGoogle, getMyProfile, listSharedWithMe, firstName } from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, watchOnline } from "./ui.js";
import { initDashShell } from "./dash-shell.js";

function showListShell() {
  document.body.classList.add("dash");
  goScreen("screen-list");
}
function showPlainScreen(id) {
  document.body.classList.remove("dash");
  goScreen(id);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function initials(name) {
  const parts = (name || "").trim().split(/\s+/);
  return ((parts[0] || "").charAt(0) + (parts[1] || "").charAt(0)) || "?";
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
  try {
    const profile = await getMyProfile();
    if (profile && profile.full_name) {
      $("mentorGreeting").textContent = `שלום, ${firstName(profile.full_name)}`;
      $("mentorAvatar").textContent = initials(profile.full_name);
    }
  } catch (e) {
    /* גם בלי שם, הרשימה עובדת */
  }
  showListShell();
  await renderList();
}

async function renderList() {
  show($("listError"), false);
  show($("listEmpty"), false);
  $("groups").innerHTML = "";
  $("listLoading").classList.remove("hidden");
  let items;
  try {
    items = await listSharedWithMe();
  } catch (e) {
    $("listLoading").classList.add("hidden");
    show($("listError"), true);
    return;
  }
  $("listLoading").classList.add("hidden");
  if (!items.length) {
    show($("listEmpty"), true);
    return;
  }

  $("navShareCount").textContent = items.length;

  // קיבוץ לפי חותם, קבוצות ממוינות לפי השיעור החדש ביותר בכל אחת
  const byTrainee = new Map();
  for (const it of items) {
    if (!byTrainee.has(it.traineeName)) byTrainee.set(it.traineeName, []);
    byTrainee.get(it.traineeName).push(it);
  }
  const groups = [...byTrainee.entries()].sort(
    (a, b) => new Date(b[1][0].created_at) - new Date(a[1][0].created_at)
  );

  for (const [traineeName, lessons] of groups) {
    const section = document.createElement("div");
    section.className = "dash-section";

    const head = document.createElement("div");
    head.className = "dash-section-head";
    const unseen = lessons.filter((l) => !l.viewedByMe).length;
    head.innerHTML =
      `<span class="cell-name"><span class="avatar">${initials(traineeName)}</span>` +
      `<h2>${esc(traineeName)}</h2></span>` +
      (unseen ? `<span class="badge-new" style="margin-inline-start:8px">${unseen} חדש</span>` : "");
    section.appendChild(head);

    const cardWrap = document.createElement("div");
    cardWrap.className = "table-card";

    // דסקטופ: טבלה
    const scroll = document.createElement("div");
    scroll.className = "dtable-scroll";
    const table = document.createElement("table");
    table.className = "dtable";
    table.innerHTML =
      `<thead><tr><th>שם השיעור</th><th>תאריך</th><th>משך</th><th></th></tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const l of lessons) {
      const tr = document.createElement("tr");
      if (!l.viewedByMe) tr.className = "flagged";
      tr.style.cursor = "pointer";
      const badge = l.viewedByMe ? "" : `<span class="badge-new" style="margin-inline-start:8px">חדש</span>`;
      tr.innerHTML =
        `<td class="lesson-title-cell">${esc(l.title || "שיעור ללא שם")}${badge}</td>` +
        `<td>${esc(humanDate(l.created_at))}</td>` +
        `<td>${esc(humanMinutes(l.duration_s))}</td>` +
        `<td><button class="row-action">לצפייה</button></td>`;
      tr.addEventListener("click", () => {
        location.href = devHref("watch.html?token=" + encodeURIComponent(l.token));
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroll.appendChild(table);

    // מובייל: שורות-כרטיס
    const cards = document.createElement("div");
    cards.className = "table-cards";
    for (const l of lessons) {
      const card = document.createElement("div");
      card.className = "trow-card" + (l.viewedByMe ? "" : " flagged");
      card.style.cursor = "pointer";
      const badge = l.viewedByMe ? "" : `<span class="badge-new" style="margin-inline-start:auto">חדש</span>`;
      card.innerHTML =
        `<div class="tc-head"><span class="tc-name">${esc(l.title || "שיעור ללא שם")}</span>${badge}</div>` +
        `<div class="tc-grid">` +
        `<div class="tc-field"><span class="k">תאריך</span><span class="v">${esc(humanDate(l.created_at))}</span></div>` +
        `<div class="tc-field"><span class="k">משך</span><span class="v">${esc(humanMinutes(l.duration_s))}</span></div>` +
        `</div>`;
      card.addEventListener("click", () => {
        location.href = devHref("watch.html?token=" + encodeURIComponent(l.token));
      });
      cards.appendChild(card);
    }

    cardWrap.append(scroll, cards);
    section.appendChild(cardWrap);
    $("groups").appendChild(section);
  }
}

$("loginBtn").addEventListener("click", signInWithGoogle);
$("listRetry").addEventListener("click", renderList);
if (!DEV) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
      boot();
    }
  });
}
boot();
