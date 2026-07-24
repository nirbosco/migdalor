// חותמטק: עמוד ניהול המשתמשים. כל הרשימה (roster) עם תפקיד, חיווי
// "נכנס/ה פעם" (יש פרופיל), שינוי תפקיד בשורה, הסרה מהרשימה (שלא
// מוחקת הקלטות) והוספת משתמש. הבסיס: rolesPanel הישן, כעמוד מלא.

import { listRoster, listProfiles, upsertPerson, removeFromRoster } from "./supa.js";
import { $, show } from "./ui.js";
import { wireSort } from "./dash-shell.js";
import { initAdminPage, esc, initials, ROLE_LABEL, ROLE_TAG } from "./admin-shell.js";

let allUsers = []; // הרשימה עם שדה entered (נכנס/ה פעם)

async function loadRoster() {
  show($("rosterError"), false);
  $("rosterLoading").classList.remove("hidden");
  $("rosterCard").hidden = true;
  let roster, profiles;
  try {
    [roster, profiles] = await Promise.all([listRoster(), listProfiles()]);
  } catch (e) {
    $("rosterLoading").classList.add("hidden");
    show($("rosterError"), true);
    return;
  }
  $("rosterLoading").classList.add("hidden");
  const entered = new Set((profiles || []).map((p) => (p.email || "").toLowerCase()));
  allUsers = roster.map((p) => ({
    ...p,
    entered: entered.has((p.email || "").toLowerCase()) ? 1 : 0,
  }));
  allUsers.sort(
    (a, b) =>
      (a.role || "").localeCompare(b.role || "") ||
      (a.full_name || "").localeCompare(b.full_name || "", "he")
  );
  $("rosterCard").hidden = false;
  renderRows(allUsers);
}

function applyFilters(list) {
  const q = ($("userSearch").value || "").trim().toLowerCase();
  const role = $("roleFilter").value;
  return list.filter((p) => {
    if (role && p.role !== role) return false;
    if (!q) return true;
    return (
      (p.full_name || "").toLowerCase().includes(q) ||
      (p.email || "").toLowerCase().includes(q)
    );
  });
}

function enteredTag(p) {
  return p.entered
    ? `<span class="tag tag-ok">נכנס/ה</span>`
    : `<span class="tag">עוד לא</span>`;
}

function renderRows(list) {
  allUsers = list;
  const filtered = applyFilters(list);
  $("userCount").textContent = filtered.length
    ? filtered.length === 1
      ? "משתמש/ת ברשימה"
      : `${filtered.length} ברשימה`
    : "אין תוצאות";

  // דסקטופ
  const rows = $("rosterRows");
  rows.innerHTML = "";
  for (const p of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td><div class="cell-name"><span class="avatar">${initials(p.full_name || p.email)}</span><span class="n">${esc(p.full_name || "—")}</span></div></td>` +
      `<td style="direction:ltr; text-align:right">${esc(p.email)}</td>` +
      `<td></td>` +
      `<td>${enteredTag(p)}</td>` +
      `<td style="text-align:left"></td>`;
    tr.children[2].appendChild(roleSelect(p));
    tr.children[4].appendChild(removeBtn(p));
    rows.appendChild(tr);
  }

  // מובייל
  const cards = $("rosterCards");
  cards.innerHTML = "";
  for (const p of filtered) {
    const card = document.createElement("div");
    card.className = "trow-card";
    const head = document.createElement("div");
    head.className = "tc-head";
    head.innerHTML =
      `<span class="avatar">${initials(p.full_name || p.email)}</span>` +
      `<span class="tc-name">${esc(p.full_name || p.email)}</span>` +
      `<span class="${ROLE_TAG[p.role] || "tag"}" style="margin-inline-start:auto">${ROLE_LABEL[p.role] || esc(p.role)}</span>`;
    const grid = document.createElement("div");
    grid.className = "tc-grid";
    const f1 = document.createElement("div");
    f1.className = "tc-field";
    f1.innerHTML = `<span class="k">מייל</span><span class="v" style="direction:ltr">${esc(p.email)}</span>`;
    const f2 = document.createElement("div");
    f2.className = "tc-field";
    f2.innerHTML = `<span class="k">כניסה ראשונה</span><span class="v">${p.entered ? "נכנס/ה" : "עוד לא"}</span>`;
    const f3 = document.createElement("div");
    f3.className = "tc-field";
    f3.innerHTML = `<span class="k">תפקיד</span>`;
    f3.appendChild(roleSelect(p));
    grid.append(f1, f2, f3);
    const actions = document.createElement("div");
    actions.className = "tc-actions";
    actions.appendChild(removeBtn(p));
    card.append(head, grid, actions);
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

function removeBtn(p) {
  const btn = document.createElement("button");
  btn.className = "row-action row-action-danger";
  btn.textContent = "להסיר";
  btn.addEventListener("click", async () => {
    if (
      !confirm(
        `להסיר את ${p.full_name || p.email} מהרשימה? ההסרה חוסמת כניסה חדשה, אבל לא מוחקת הקלטות קיימות.`
      )
    )
      return;
    btn.disabled = true;
    try {
      await removeFromRoster(p.email);
      await loadRoster();
    } catch (e) {
      btn.disabled = false;
      alert("ההסרה נכשלה: " + (e.message || e));
    }
  });
  return btn;
}

function wireAddForm() {
  $("roleForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    show($("roleDone"), false);
    show($("roleError"), false);
    const email = $("roleEmail").value.trim().toLowerCase();
    const full_name = $("roleName").value.trim();
    const role = $("roleSelect").value;
    try {
      await upsertPerson({ email, full_name, role });
      $("roleDone").textContent = `${full_name || email} נשמר ברשימה בתפקיד ${ROLE_LABEL[role]}.`;
      show($("roleDone"), true);
      $("roleForm").reset();
      await loadRoster();
    } catch (err) {
      $("roleError").textContent = "השמירה נכשלה: " + (err.message || err);
      show($("roleError"), true);
    }
  });
}

$("rosterRetry").addEventListener("click", loadRoster);
$("userSearch").addEventListener("input", () => renderRows(allUsers));
$("roleFilter").addEventListener("change", () => renderRows(allUsers));
wireSort(
  $("rosterTable"),
  () => allUsers,
  (sorted) => renderRows(sorted)
);

initAdminPage({
  page: "users",
  onReady: async () => {
    wireAddForm();
    await loadRoster();
  },
});
