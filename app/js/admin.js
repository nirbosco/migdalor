// המגדלור: פאנל האדמין. בנוי סביב "למי צריך לעזור היום", ורק אחר כך נתונים.
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
} from "./supa.js";
import { $, show, goScreen, humanDate, watchOnline } from "./ui.js";

let parsed = null;

async function boot() {
  if (DEV) document.body.classList.add("dev");
  watchOnline();

  const user = await getUser();
  if (!user) {
    goScreen("screen-login");
    return;
  }
  let profile = null;
  try {
    profile = await getMyProfile();
  } catch (e) {
    /* ייחסם למטה */
  }
  if (!profile || profile.role !== "admin") {
    goScreen("screen-denied");
    return;
  }
  $("backToApp").href = devHref("index.html?stay=1");
  $("toMentor").href = devHref("mentor.html");
  goScreen("screen-admin");
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
    s.textContent = "כדאי להתקשר לחותם: הסרטון שמור אצלו בטלפון, וכניסה מחודשת לאתר ממשיכה את ההעלאה.";
    card.append(t, m, s);
    $("failedUploads").appendChild(card);
  }

  // טבלת החותמים
  const rows = $("traineeRows");
  rows.innerHTML = "";
  $("traineeTable").classList.remove("hidden");
  const sorted = [...data.trainees].sort((a, b) =>
    (a.full_name || "").localeCompare(b.full_name || "", "he")
  );
  for (const tr of sorted) {
    const row = document.createElement("tr");
    const stuck = !tr.lastRecording;
    if (stuck) row.className = "flagged";
    const cells = [
      tr.full_name,
      tr.lastRecording ? humanDate(tr.lastRecording) : "עוד לא צילם",
      String(tr.shares),
      String(tr.viewed),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      row.appendChild(td);
    }
    rows.appendChild(row);
  }
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
      problems.push(`שורה ${i + 1}: מייל החותם לא תקין (${traineeEmail || "ריק"})`);
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
      ? `זיהינו ${trainees.size} חותמים ו-${mentorsSet.size} מנטורים, ובסך הכול ${parsed.rows.length} שיבוצים.`
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
    } catch (err) {
      $("manualError").textContent = "השיבוץ לא נשמר: " + (err.message || err);
      show($("manualError"), true);
    }
  });
}

$("loginBtn").addEventListener("click", signInWithGoogle);
$("tableRetry").addEventListener("click", renderOverview);
if (!DEV) {
  supabase.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN" && document.querySelector("#screen-login.active")) {
      boot();
    }
  });
}
wireCsv();
wireManual();
boot();
