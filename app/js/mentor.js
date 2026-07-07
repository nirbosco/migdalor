// המגדלור: המסך של המנטור. כל מה ששותף איתי, מקובץ לפי חותם,
// ממוין מהחדש לישן, עם סימון "חדש" על מה שטרם נצפה.

import { DEV, devHref } from "./config.js";
import { supabase, getUser, signInWithGoogle, getMyProfile, listSharedWithMe, firstName } from "./supa.js";
import { $, show, goScreen, humanDate, humanMinutes, watchOnline } from "./ui.js";

async function boot() {
  if (DEV) document.body.classList.add("dev");
  watchOnline();

  const user = await getUser();
  if (!user) {
    goScreen("screen-login");
    return;
  }
  try {
    const profile = await getMyProfile();
    if (profile && profile.full_name) {
      $("mentorGreeting").textContent = `שלום, ${firstName(profile.full_name)}. כל החותמים שלך`;
    }
  } catch (e) {
    /* גם בלי שם, הרשימה עובדת */
  }
  goScreen("screen-list");
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

  // קיבוץ לפי חותם, והקבוצות ממוינות לפי השיעור החדש ביותר בכל אחת
  const byTrainee = new Map();
  for (const it of items) {
    if (!byTrainee.has(it.traineeName)) byTrainee.set(it.traineeName, []);
    byTrainee.get(it.traineeName).push(it);
  }
  const groups = [...byTrainee.entries()].sort(
    (a, b) => new Date(b[1][0].created_at) - new Date(a[1][0].created_at)
  );

  for (const [traineeName, lessons] of groups) {
    const h = document.createElement("h2");
    h.className = "mt";
    h.textContent = traineeName;
    $("groups").appendChild(h);
    for (const l of lessons) {
      const card = document.createElement("div");
      card.className = "card";
      card.style.cursor = "pointer";
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = l.title || "שיעור ללא שם";
      if (!l.viewedByMe) {
        const badge = document.createElement("span");
        badge.className = "badge-new";
        badge.textContent = "חדש";
        title.appendChild(badge);
      }
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${humanDate(l.created_at)} | ${humanMinutes(l.duration_s)}`;
      card.append(title, meta);
      card.addEventListener("click", () => {
        location.href = devHref("watch.html?token=" + encodeURIComponent(l.token));
      });
      $("groups").appendChild(card);
    }
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
