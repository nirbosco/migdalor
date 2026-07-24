// חותמטק: שכבת הנתונים. קליינט Supabase, התחברות, ושאילתות לכל המסכים.
// כל ההרשאות נאכפות ב-RLS בצד השרת; הקוד כאן רק שואל ומציג.
//
// מצב תצוגה (?dev=1): מדמה משתמש מחובר ומחזיר נתוני הדגמה קבועים,
// כדי שאפשר יהיה לבדוק את הממשק בלי חשבון גוגל. שום דבר לא נכתב לשרת,
// וגם אם היה נכתב, ה-RLS חוסם אנונימיים ממילא.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON, WORKER_URL, DEV } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------- מצב תצוגה: נתוני הדגמה ----------

const DEV_USER = {
  id: "00000000-0000-0000-0000-00000000dev1",
  email: "moshe.demo@example.com",
  user_metadata: { full_name: "משה (הדגמה)" },
};

const DEV_PROFILE = {
  id: DEV_USER.id,
  email: DEV_USER.email,
  full_name: "משה (הדגמה)",
  role: new URLSearchParams(location.search).get("role") || "trainee",
};

const DEV_MENTORS = [
  { email: "ehud.demo@example.com", full_name: "אהוד (הדגמה)" },
  { email: "ruth.demo@example.com", full_name: "רות (הדגמה)" },
];

const DEV_RECORDINGS = [
  {
    id: "dev-rec-1",
    title: "שיעור מיום ראשון, 5.7",
    duration_s: 2580,
    created_at: "2026-07-05T10:00:00Z",
    status: "ready",
    sharedWith: ["אהוד (הדגמה)"],
    token: "dev-token-1",
  },
  {
    id: "dev-rec-2",
    title: "שיעור מיום שני, 6.7",
    duration_s: 1440,
    created_at: "2026-07-06T09:00:00Z",
    status: "ready",
    sharedWith: [],
    token: null,
  },
];

// ---------- התחברות ----------

export async function getUser() {
  if (DEV) return DEV_USER;
  const { data } = await supabase.auth.getSession();
  return data.session ? data.session.user : null;
}

export async function getAccessToken() {
  if (DEV) return "dev";
  const { data } = await supabase.auth.getSession();
  return data.session ? data.session.access_token : null;
}

export async function signInWithGoogle() {
  const redirectTo = location.origin + location.pathname + location.search;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
}

// כניסה עם קישור קסם למייל (OTP), למסכי הצוות בלבד: מייל ארגוני של TFI.
// הקישור מחזיר לאותו עמוד בדיוק, ו-onAuthStateChange הקיים קולט את הכניסה.
// מחיקת הקלטה (בעלים או אדמין): המסד + הקובץ בענן, דרך ה-Worker.
export async function deleteRecording(recordingId) {
  if (DEV) {
    // גם בהדגמה המחיקה מרגישה אמיתית: הרשומה יורדת מנתוני ההדגמה
    if (_devAdmin) {
      _devAdmin.recordings = _devAdmin.recordings.filter((r) => r.id !== recordingId);
    }
    return { ok: true };
  }
  const { WORKER_URL } = await import("./config.js");
  const jwt = await getAccessToken();
  const res = await fetch(WORKER_URL + "/mine/" + encodeURIComponent(recordingId), {
    method: "DELETE",
    headers: { authorization: "Bearer " + jwt },
  });
  if (!res.ok) throw new Error((await res.text()) || "המחיקה נכשלה");
  return { ok: true };
}

export async function signInWithEmailOtp(email) {
  if (DEV) return true;
  const { error } = await supabase.auth.signInWithOtp({
    email: (email || "").trim().toLowerCase(),
    options: { emailRedirectTo: location.href },
  });
  if (error) throw error;
  return true;
}

export async function signOut() {
  if (!DEV) await supabase.auth.signOut();
}

export function firstName(fullName) {
  return (fullName || "").trim().split(/\s+/)[0] || "";
}

// ---------- פרופיל ורישום ----------

export async function getMyProfile() {
  if (DEV) return DEV_PROFILE;
  const user = await getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("migdalor_profiles")
    .select("id,email,full_name,role")
    .eq("id", user.id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// האם המשתמש רשום ברשימת השיבוץ? (הטריגר יוצר פרופיל לכל נכנס,
// ולכן הבדיקה האמינה היא מול migdalor_roster.)
export async function isInRoster(email) {
  if (DEV) return true;
  const { data, error } = await supabase
    .from("migdalor_roster")
    .select("email")
    .eq("email", (email || "").toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function submitJoinRequest(fullName, phone) {
  if (DEV) return true;
  const user = await getUser();
  const { error } = await supabase.from("migdalor_join_requests").insert({
    email: (user.email || "").toLowerCase(),
    full_name: fullName,
    phone,
  });
  if (error) throw error;
  return true;
}

// ---------- חותמיסט: הקלטות, מנטורים, שיתופים ----------

export async function listMyMentors() {
  if (DEV) return DEV_MENTORS;
  const me = await getMyProfile();
  const { data: assignments, error } = await supabase
    .from("migdalor_assignments")
    .select("mentor_email")
    .eq("trainee_email", me.email);
  if (error) throw error;
  const emails = [...new Set(assignments.map((a) => a.mentor_email))];
  if (!emails.length) return [];
  const { data: roster, error: e2 } = await supabase
    .from("migdalor_roster")
    .select("email,full_name")
    .in("email", emails);
  if (e2) throw e2;
  return emails.map((email) => ({
    email,
    full_name:
      (roster.find((r) => r.email === email) || {}).full_name || email,
  }));
}

// ההקלטות שלי ועם מי שותפו, מוכן לשורת הסטטוס האנושית.
// בכוונה לא שואלים מי צפה: החותמיסט לא נחשף לנתוני צפייה (החלטת 16.7).
export async function listMyRecordings() {
  if (DEV) return DEV_RECORDINGS;
  const user = await getUser();
  const { data: recs, error } = await supabase
    .from("migdalor_recordings")
    .select("id,title,duration_s,created_at,status")
    .eq("owner_id", user.id)
    .eq("kind", "lesson")
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!recs.length) return [];

  const ids = recs.map((r) => r.id);
  const { data: shares } = await supabase
    .from("migdalor_shares")
    .select("id,recording_id,token,shared_with_email,revoked")
    .in("recording_id", ids)
    .eq("revoked", false);
  // שמות מובילי הבית מרשימת השיבוץ (מותר לי לראות את מובילי הבית שלי)
  const emails = [
    ...new Set((shares || []).map((s) => s.shared_with_email).filter(Boolean)),
  ];
  let names = {};
  if (emails.length) {
    const { data: roster } = await supabase
      .from("migdalor_roster")
      .select("email,full_name")
      .in("email", emails);
    (roster || []).forEach((r) => (names[r.email] = r.full_name || r.email));
  }
  return recs.map((r) => {
    const myShares = (shares || []).filter((s) => s.recording_id === r.id);
    const recipients = myShares.filter((s) => s.shared_with_email);
    return {
      ...r,
      token: myShares.length ? myShares[0].token : null,
      sharedWith: recipients.map(
        (s) => names[s.shared_with_email] || s.shared_with_email
      ),
    };
  });
}

export async function createRecording({ title, duration_s, mime }) {
  if (DEV) return { id: "dev-rec-new", title, duration_s, mime };
  const user = await getUser();
  const { data, error } = await supabase
    .from("migdalor_recordings")
    .insert({ owner_id: user.id, title, duration_s, mime, status: "uploading" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRecordingTitle(id, title) {
  if (DEV) return;
  const { error } = await supabase
    .from("migdalor_recordings")
    .update({ title })
    .eq("id", id);
  if (error) throw error;
}

export async function markRecordingFailed(id) {
  if (DEV) return;
  try {
    await supabase
      .from("migdalor_recordings")
      .update({ status: "failed" })
      .eq("id", id);
  } catch (e) {
    /* גם אם הסימון נכשל, הסרטון שמור מקומית */
  }
}

// טוקן צפייה אחד לכל הקלטה: נוצר בשיתוף הראשון וחוזר בכל שיתוף נוסף,
// כדי שהקישור שהודבק בחותמית יישאר תקף גם כשמוסיפים מנטור.
function newToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function getOrCreateToken(recordingId) {
  if (DEV) return "dev-token-new";
  const user = await getUser();
  const { data: existing, error } = await supabase
    .from("migdalor_shares")
    .select("token")
    .eq("recording_id", recordingId)
    .eq("revoked", false)
    .limit(1);
  if (error) throw error;
  if (existing && existing.length) return existing[0].token;
  // שורת עוגן בלי נמען: מסמנת שהקישור קיים (למשל הועתק לחותמית)
  const token = newToken();
  const { error: e2 } = await supabase.from("migdalor_shares").insert({
    recording_id: recordingId,
    token,
    shared_with_email: null,
    created_by: user.id,
  });
  if (e2) throw e2;
  return token;
}

export async function shareWithMentors(recordingId, mentorEmails) {
  if (DEV) return "dev-token-new";
  const user = await getUser();
  const token = await getOrCreateToken(recordingId);
  const { data: existing } = await supabase
    .from("migdalor_shares")
    .select("shared_with_email")
    .eq("recording_id", recordingId)
    .eq("revoked", false);
  const already = new Set(
    (existing || []).map((s) => s.shared_with_email).filter(Boolean)
  );
  const rows = mentorEmails
    .filter((e) => !already.has(e))
    .map((email) => ({
      recording_id: recordingId,
      token,
      shared_with_email: email,
      created_by: user.id,
    }));
  if (rows.length) {
    const { error } = await supabase.from("migdalor_shares").insert(rows);
    if (error) throw error;
  }
  return token;
}

// ---------- מנטור ----------

export async function listSharedWithMe() {
  if (DEV) {
    return [
      {
        shareId: "dev-share-1",
        token: "dev-token-1",
        traineeName: "משה (הדגמה)",
        title: "שיעור מיום ראשון, 5.7",
        duration_s: 2580,
        created_at: "2026-07-05T10:00:00Z",
        viewedByMe: false,
      },
      {
        shareId: "dev-share-2",
        token: "dev-token-0",
        traineeName: "שרה (הדגמה)",
        title: "שיעור מיום חמישי, 2.7",
        duration_s: 1980,
        created_at: "2026-07-02T12:00:00Z",
        viewedByMe: true,
      },
    ];
  }
  const me = await getMyProfile();
  const { data: shares, error } = await supabase
    .from("migdalor_shares")
    .select(
      "id,token,created_at,recording_id,migdalor_recordings(id,title,duration_s,created_at,owner_id,status)"
    )
    .eq("shared_with_email", me.email)
    .eq("revoked", false)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const { data: myViews } = await supabase
    .from("migdalor_views")
    .select("share_id")
    .eq("viewer_email", me.email);
  const viewed = new Set((myViews || []).map((v) => v.share_id));

  // שמות החותמיסטים: דרך הפרופילים (מותר למנטור לראות את החותמיסטים שלו)
  const ownerIds = [
    ...new Set(
      (shares || [])
        .map((s) => s.migdalor_recordings && s.migdalor_recordings.owner_id)
        .filter(Boolean)
    ),
  ];
  let owners = {};
  if (ownerIds.length) {
    const { data: profs } = await supabase
      .from("migdalor_profiles")
      .select("id,full_name,email")
      .in("id", ownerIds);
    (profs || []).forEach(
      (p) => (owners[p.id] = p.full_name || p.email)
    );
  }
  return (shares || [])
    .filter((s) => s.migdalor_recordings && s.migdalor_recordings.status === "ready")
    .map((s) => ({
      shareId: s.id,
      token: s.token,
      traineeName: owners[s.migdalor_recordings.owner_id] || "חותמיסט",
      title: s.migdalor_recordings.title,
      duration_s: s.migdalor_recordings.duration_s,
      created_at: s.migdalor_recordings.created_at,
      viewedByMe: viewed.has(s.id),
    }));
}

// ---------- אדמין ----------

// מצב תצוגה: מחולל נתוני הדגמה בהיקף אמיתי לעמודי הניהול.
// כ-25 חותמיסטים, 8 מובילים, 40 שיעורים ו-40+ שיבוצים, דטרמיניסטי,
// כדי שההדגמה תיראה מלאה ואחידה בכל טעינה ובכל עמוד.
let _devAdmin = null;
function devAdminData() {
  if (_devAdmin) return _devAdmin;
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const FIRST = [
    "נועה", "איתי", "תמר", "יונתן", "מיכל", "עומר", "שירה", "דניאל", "הילה",
    "אלון", "רוני", "יעל", "אורי", "ליאור", "אביגיל", "נדב", "מאיה", "עידו",
    "טליה", "אסף", "נטע", "גיא", "שני", "עמית", "הדר", "יובל", "ענבר", "תום",
    "רעות", "אביב", "כרמל", "שקד", "אלה", "מתן",
  ];
  const LAST = [
    "כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אברהם", "פרידמן", "שפירא",
    "גבאי", "דהן", "אזולאי", "חדד", "עמר", "בן דוד", "רוזן", "קדוש",
  ];
  const used = new Set();
  const uniqueName = () => {
    for (let i = 0; i < 50; i++) {
      const n = FIRST[Math.floor(rnd() * FIRST.length)] + " " + LAST[Math.floor(rnd() * LAST.length)];
      if (!used.has(n)) {
        used.add(n);
        return n;
      }
    }
    return "פלוני אלמוני " + used.size;
  };

  const mentors = [];
  for (let i = 0; i < 8; i++) {
    mentors.push({ email: `m${i + 1}.demo@example.com`, full_name: uniqueName(), role: "mentor" });
  }
  const traineePeople = [];
  for (let i = 0; i < 25; i++) {
    traineePeople.push({ email: `t${i + 1}.demo@example.com`, full_name: uniqueName(), role: "trainee" });
  }
  const roster = [
    ...traineePeople,
    ...mentors,
    { email: "nir.demo@example.com", full_name: "ניר (הדגמה)", role: "admin" },
  ];

  const DAY = 24 * 3600 * 1000;
  const base = Date.parse("2026-07-01T08:00:00Z");

  // שיבוצים: לכל חותמיסט מוביל בית, ולרובם גם מוביל דעת
  const assignments = [];
  let aid = 0;
  const houseOf = {};
  traineePeople.forEach((t, i) => {
    const house = mentors[i % 5];
    houseOf[t.email] = house;
    assignments.push({
      id: "dev-asg-" + ++aid,
      trainee_email: t.email,
      trainee_name: t.full_name,
      mentor_email: house.email,
      mentor_name: house.full_name,
      assignment_type: "מוביל בית",
      created_at: new Date(base + (i % 10) * DAY).toISOString(),
    });
    if (i % 3 !== 0) {
      const daat = mentors[5 + (i % 3)];
      assignments.push({
        id: "dev-asg-" + ++aid,
        trainee_email: t.email,
        trainee_name: t.full_name,
        mentor_email: daat.email,
        mentor_name: daat.full_name,
        assignment_type: "מוביל דעת",
        created_at: new Date(base + (i % 10) * DAY).toISOString(),
      });
    }
  });

  // שיעורים: 40, מפוזרים בין החותמיסטים. רובם מוכנים, אחד נכשל ואחד תקוע.
  const WD = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const recordings = [];
  for (let i = 0; i < 40; i++) {
    const t = traineePeople[Math.floor(rnd() * traineePeople.length)];
    const created = new Date(base + Math.floor(rnd() * 21) * DAY + Math.floor(rnd() * 10) * 3600 * 1000);
    const status = i === 5 ? "failed" : i === 11 ? "uploading" : "ready";
    const shared = status === "ready" && rnd() < 0.72;
    const viewed = shared && rnd() < 0.6;
    recordings.push({
      id: "dev-rec-" + (i + 1),
      title: `שיעור מיום ${WD[created.getDay()]}, ${created.getDate()}.${created.getMonth() + 1}`,
      owner_email: t.email,
      ownerEmail: t.email,
      ownerName: t.full_name,
      duration_s: 1200 + Math.floor(rnd() * 2400),
      created_at: created.toISOString(),
      status,
      sharedWith: shared ? [houseOf[t.email].full_name] : [],
      viewed,
      hasAnalysis: shared && rnd() < 0.5,
    });
  }
  recordings.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  // מבט-העל של החותמיסטים נגזר מהשיעורים, כמו בשאילתה האמיתית
  const trainees = traineePeople.map((t) => {
    const myRecs = recordings.filter((r) => r.owner_email === t.email);
    const readyRecs = myRecs.filter((r) => r.status === "ready");
    const shares = readyRecs.filter((r) => r.sharedWith.length).length;
    const viewed = readyRecs.filter((r) => r.viewed).length;
    const last = myRecs.length ? myRecs[0].created_at : null;
    return {
      email: t.email,
      full_name: t.full_name,
      lastRecording: last,
      recordings: myRecs.length,
      shares,
      viewed,
    };
  });

  // פרופילים: כשלושה רבעים מהחותמיסטים כבר נכנסו פעם, וכל הצוות
  const profiles = roster
    .filter((p, i) => p.role !== "trainee" || i % 4 !== 3)
    .map((p) => ({ email: p.email, full_name: p.full_name, role: p.role }));

  const joinRequests = [
    {
      email: "new.demo@example.com",
      full_name: "יעקב (הדגמה)",
      phone: "050-0000000",
      created_at: "2026-07-20T08:00:00Z",
    },
  ];
  const failedUploads = recordings
    .filter((r) => r.status === "failed" || r.status === "uploading")
    .map((r) => ({ ...r }));

  _devAdmin = { roster, assignments, recordings, trainees, profiles, joinRequests, failedUploads };
  return _devAdmin;
}

export async function adminOverview() {
  if (DEV) {
    const d = devAdminData();
    return {
      trainees: d.trainees.map((t) => ({ ...t })),
      joinRequests: d.joinRequests.map((j) => ({ ...j })),
      failedUploads: d.failedUploads.map((f) => ({ ...f })),
    };
  }
  const [{ data: roster }, { data: recs }, { data: shares }, { data: views }] =
    await Promise.all([
      supabase.from("migdalor_roster").select("email,full_name,role"),
      supabase
        .from("migdalor_recordings")
        .select("id,owner_id,created_at,status,title"),
      supabase
        .from("migdalor_shares")
        .select("id,recording_id,shared_with_email,revoked")
        .eq("revoked", false),
      supabase.from("migdalor_views").select("share_id,viewer_email"),
    ]);
  const { data: profiles } = await supabase
    .from("migdalor_profiles")
    .select("id,email");
  const emailById = {};
  (profiles || []).forEach((p) => (emailById[p.id] = p.email));

  const viewedShareIds = new Set((views || []).map((v) => v.share_id));

  const trainees = (roster || [])
    .filter((r) => r.role === "trainee")
    .map((r) => {
      const myRecs = (recs || []).filter(
        (rec) => emailById[rec.owner_id] === r.email
      );
      const recIds = new Set(myRecs.map((x) => x.id));
      const myShares = (shares || []).filter(
        (s) => recIds.has(s.recording_id) && s.shared_with_email
      );
      const viewedCount = myShares.filter((s) =>
        viewedShareIds.has(s.id)
      ).length;
      const last = myRecs.length
        ? myRecs.map((x) => x.created_at).sort().slice(-1)[0]
        : null;
      return {
        email: r.email,
        full_name: r.full_name || r.email,
        lastRecording: last,
        recordings: myRecs.length,
        shares: myShares.length,
        viewed: viewedCount,
      };
    });

  // בקשות הצטרפות: הטבלה נוצרת ב-SETUP; אם עוד לא קיימת, ממשיכים בלעדיה.
  let joinRequests = [];
  try {
    const { data: jr, error } = await supabase
      .from("migdalor_join_requests")
      .select("email,full_name,phone,created_at,handled")
      .eq("handled", false)
      .order("created_at", { ascending: false });
    if (!error) joinRequests = jr || [];
  } catch (e) {
    /* הטבלה עוד לא קיימת */
  }

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const failedUploads = (recs || []).filter(
    (rec) =>
      rec.status === "failed" ||
      (rec.status === "uploading" &&
        new Date(rec.created_at).getTime() < dayAgo)
  );
  const ownersOfFailed = failedUploads.map((rec) => ({
    ...rec,
    ownerEmail: emailById[rec.owner_id] || "",
  }));

  return { trainees, joinRequests, failedUploads: ownersOfFailed };
}

export async function upsertRosterRows(rows) {
  if (DEV) {
    const d = devAdminData();
    (rows || []).forEach((r) => {
      const found = d.roster.find((p) => p.email === r.email);
      if (found) {
        if (r.full_name && !found.full_name) found.full_name = r.full_name;
      } else {
        d.roster.push({ email: r.email, full_name: r.full_name || "", role: r.role || "trainee" });
      }
    });
    return;
  }
  const { error } = await supabase
    .from("migdalor_roster")
    .upsert(rows, { onConflict: "email" });
  if (error) throw error;
}

// ---------- ניהול תפקידים (אדמין) ----------

// כל הרשומות ב-roster, ממוין לפי תפקיד ואז שם. לאדמין בלבד (roster_select).
export async function listRoster() {
  if (DEV) return devAdminData().roster.map((p) => ({ ...p }));
  const { data, error } = await supabase
    .from("migdalor_roster")
    .select("email,full_name,role");
  if (error) throw error;
  return data || [];
}

// הוספה/עדכון של אדם עם תפקיד:
// 1. upsert ל-roster (email מפתח, on conflict מעדכן role+full_name).
// 2. אם כבר קיים פרופיל למייל הזה, מעדכן גם את migdalor_profiles.role,
//    כדי שאדם קיים יקבל את התפקיד החדש מיד ולא רק בהרשמה הבאה.
// אישור בקשת הצטרפות: מוסיף לרשימה בתפקיד שנבחר ומסמן את הבקשה כטופלה
export async function approveJoinRequest({ email, full_name, role }) {
  await upsertPerson({ email, full_name, role });
  if (DEV) {
    const d = devAdminData();
    d.joinRequests = d.joinRequests.filter((j) => j.email !== email);
    return true;
  }
  const { error } = await supabase
    .from("migdalor_join_requests")
    .update({ handled: true })
    .eq("email", email);
  if (error) throw error;
  return true;
}

// דחיית בקשה: רק מסמנים כטופלה, בלי להוסיף לרשימה
export async function dismissJoinRequest(email) {
  if (DEV) {
    const d = devAdminData();
    d.joinRequests = d.joinRequests.filter((j) => j.email !== email);
    return true;
  }
  const { error } = await supabase
    .from("migdalor_join_requests")
    .update({ handled: true })
    .eq("email", email);
  if (error) throw error;
  return true;
}

export async function upsertPerson({ email, full_name, role }) {
  if (DEV) {
    const d = devAdminData();
    const e2 = (email || "").trim().toLowerCase();
    const found = d.roster.find((p) => p.email === e2);
    if (found) {
      found.role = role;
      if (full_name) found.full_name = full_name;
    } else {
      d.roster.push({ email: e2, full_name: (full_name || "").trim(), role });
    }
    return;
  }
  const e = (email || "").trim().toLowerCase();
  const { error } = await supabase
    .from("migdalor_roster")
    .upsert({ email: e, full_name: (full_name || "").trim(), role }, { onConflict: "email" });
  if (error) throw error;
  // עדכון הפרופיל הקיים, אם יש (לא חובה שיצליח: אולי עוד לא נרשם)
  const { data: prof } = await supabase
    .from("migdalor_profiles")
    .select("id")
    .eq("email", e)
    .maybeSingle();
  if (prof && prof.id) {
    await supabase.from("migdalor_profiles").update({ role }).eq("id", prof.id);
  }
}

export async function removeFromRoster(email) {
  if (DEV) {
    const d = devAdminData();
    const e = (email || "").trim().toLowerCase();
    d.roster = d.roster.filter((p) => p.email !== e);
    return;
  }
  const { error } = await supabase
    .from("migdalor_roster")
    .delete()
    .eq("email", (email || "").trim().toLowerCase());
  if (error) throw error;
}

// כל הפרופילים (מי שנכנס לפחות פעם אחת). לאדמין בלבד, לעמוד המשתמשים.
export async function listProfiles() {
  if (DEV) return devAdminData().profiles.map((p) => ({ ...p }));
  const { data, error } = await supabase
    .from("migdalor_profiles")
    .select("email,full_name,role");
  if (error) throw error;
  return data || [];
}

// ---------- שיבוצים (אדמין) ----------

// כל השיבוצים עם שמות משני הצדדים, החדש קודם. שליפה מרוכזת אחת + roster.
export async function listAssignments() {
  if (DEV) return devAdminData().assignments.map((a) => ({ ...a }));
  const [{ data: rows, error }, { data: roster, error: e2 }] = await Promise.all([
    supabase
      .from("migdalor_assignments")
      .select("id,trainee_email,mentor_email,assignment_type,created_at")
      .order("created_at", { ascending: false }),
    supabase.from("migdalor_roster").select("email,full_name"),
  ]);
  if (error) throw error;
  if (e2) throw e2;
  const names = {};
  (roster || []).forEach((r) => (names[r.email] = r.full_name || ""));
  return (rows || []).map((a) => ({
    ...a,
    trainee_name: names[a.trainee_email] || "",
    mentor_name: names[a.mentor_email] || "",
  }));
}

export async function removeAssignment(id) {
  if (DEV) {
    const d = devAdminData();
    d.assignments = d.assignments.filter((a) => a.id !== id);
    return;
  }
  const { error } = await supabase
    .from("migdalor_assignments")
    .delete()
    .eq("id", id);
  if (error) throw error;
}

// ---------- כל השיעורים (אדמין) ----------

// עמוד השיעורים: כל ההקלטות מסוג שיעור, בעימוד. לכל שיעור: שם החותמיסט,
// עם מי שותף, האם נצפה והאם יש ניתוח חכם. שליפות מרוכזות לפי העמוד
// הנוכחי בלבד (בלי N+1), והמחיר נשאר קבוע גם עם מאות שיעורים.
export async function listAllRecordings({ limit = 50, offset = 0 } = {}) {
  if (DEV) {
    const all = devAdminData().recordings;
    return { rows: all.slice(offset, offset + limit).map((r) => ({ ...r })), total: all.length };
  }
  const { data: recs, count, error } = await supabase
    .from("migdalor_recordings")
    .select("id,owner_id,title,duration_s,created_at,status", { count: "exact" })
    .eq("kind", "lesson")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const rows = recs || [];
  if (!rows.length) return { rows: [], total: count || 0 };

  const ids = rows.map((r) => r.id);
  const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
  const [{ data: profs }, { data: shares }, { data: analyses }] = await Promise.all([
    supabase.from("migdalor_profiles").select("id,email,full_name").in("id", ownerIds),
    supabase
      .from("migdalor_shares")
      .select("id,recording_id,shared_with_email")
      .eq("revoked", false)
      .in("recording_id", ids),
    supabase.from("migdalor_analyses").select("recording_id,status").in("recording_id", ids),
  ]);

  const shareIds = (shares || []).map((s) => s.id);
  let views = [];
  if (shareIds.length) {
    const { data: v } = await supabase
      .from("migdalor_views")
      .select("share_id")
      .in("share_id", shareIds);
    views = v || [];
  }
  const recipEmails = [
    ...new Set((shares || []).map((s) => s.shared_with_email).filter(Boolean)),
  ];
  const recipNames = {};
  if (recipEmails.length) {
    const { data: ro } = await supabase
      .from("migdalor_roster")
      .select("email,full_name")
      .in("email", recipEmails);
    (ro || []).forEach((r) => (recipNames[r.email] = r.full_name || r.email));
  }

  const owners = {};
  (profs || []).forEach((p) => (owners[p.id] = { name: p.full_name || p.email, email: p.email }));
  const viewedShares = new Set(views.map((v) => v.share_id));
  const analyzed = new Set(
    (analyses || []).filter((a) => a.status === "ready").map((a) => a.recording_id)
  );

  return {
    rows: rows.map((r) => {
      const myShares = (shares || []).filter(
        (s) => s.recording_id === r.id && s.shared_with_email
      );
      return {
        ...r,
        ownerName: (owners[r.owner_id] || {}).name || "",
        ownerEmail: (owners[r.owner_id] || {}).email || "",
        sharedWith: myShares.map((s) => recipNames[s.shared_with_email] || s.shared_with_email),
        viewed: myShares.some((s) => viewedShares.has(s.id)),
        hasAnalysis: analyzed.has(r.id),
      };
    }),
    total: count || rows.length,
  };
}

// השיעורים של חותמיסט אחד (לשורת הפירוט בעמוד החותמיסטים)
export async function listRecordingsOfTrainee(email) {
  if (DEV) {
    return devAdminData()
      .recordings.filter((r) => r.owner_email === email)
      .map((r) => ({ ...r }));
  }
  const { data: prof } = await supabase
    .from("migdalor_profiles")
    .select("id")
    .eq("email", (email || "").toLowerCase())
    .maybeSingle();
  if (!prof || !prof.id) return [];
  const { data, error } = await supabase
    .from("migdalor_recordings")
    .select("id,title,duration_s,created_at,status")
    .eq("owner_id", prof.id)
    .eq("kind", "lesson")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---------- ייבוא שיבוצים: משיכת גיליון גוגל (אדמין) ----------

// במצב תצוגה מדמים משיכה מוצלחת בלי רשת: כותרות התבנית, שתי שורות
// תקינות ושורה אחת שבורה, כדי שגם מסך הבדיקה ייראה בפעולה.
const DEV_SHEET_CSV = [
  "מייל חותמיסט,שם חותמיסט,מייל מוביל בית,שם מוביל בית,סוג שיבוץ (לא חובה)",
  'moshe.demo@example.com,משה (הדגמה),ehud.demo@example.com,אהוד (הדגמה),"מוביל בית, כיתה ז"',
  "sara.demo@example.com,שרה (הדגמה),ruth.demo@example.com,רות (הדגמה),",
  "בלי-מייל,יעקב (הדגמה),ehud.demo@example.com,אהוד (הדגמה),",
].join("\n");

// מושך את הגיליון כ-CSV דרך ה-Worker (לגוגל אין CORS, וה-Worker גם
// אוכף שרק אדמין מחובר מושך). שגיאות חוזרות בעברית כמו שהן מהשרת.
export async function fetchSheetCsv(sheetId, gid) {
  if (DEV) return DEV_SHEET_CSV;
  const token = await getAccessToken();
  if (!token) throw new Error("נדרשת כניסה מחדש");
  const res = await fetch(
    `${WORKER_URL}/sheet?id=${encodeURIComponent(sheetId)}&gid=${encodeURIComponent(gid || "0")}`,
    { headers: { authorization: "Bearer " + token } }
  );
  const text = await res.text();
  if (!res.ok) {
    let msg = "המשיכה נכשלה. מנסים שוב עוד רגע.";
    try {
      msg = JSON.parse(text).error || msg;
    } catch (e) {
      /* לא JSON: נשארים עם ההודעה הכללית */
    }
    throw new Error(msg);
  }
  return text;
}

export async function addAssignments(rows) {
  if (DEV) {
    // גם בהדגמה הטעינה מרגישה אמיתית: שיבוצים חדשים נכנסים לנתוני ההדגמה
    const d = devAdminData();
    const have = new Set(d.assignments.map((a) => a.trainee_email + "|" + a.mentor_email));
    const names = {};
    d.roster.forEach((p) => (names[p.email] = p.full_name));
    const fresh = (rows || []).filter(
      (r) => !have.has(r.trainee_email + "|" + r.mentor_email)
    );
    fresh.forEach((r, i) => {
      d.assignments.unshift({
        id: "dev-asg-new-" + Date.now() + "-" + i,
        trainee_email: r.trainee_email,
        trainee_name: names[r.trainee_email] || "",
        mentor_email: r.mentor_email,
        mentor_name: names[r.mentor_email] || "",
        assignment_type: r.assignment_type || "",
        created_at: new Date().toISOString(),
      });
    });
    return fresh.length;
  }
  // אין אילוץ ייחודיות בטבלה, ולכן בודקים כפילויות לפני הכנסה.
  const { data: existing, error } = await supabase
    .from("migdalor_assignments")
    .select("trainee_email,mentor_email");
  if (error) throw error;
  const have = new Set(
    (existing || []).map((a) => a.trainee_email + "|" + a.mentor_email)
  );
  const fresh = rows.filter(
    (r) => !have.has(r.trainee_email + "|" + r.mentor_email)
  );
  if (fresh.length) {
    const { error: e2 } = await supabase
      .from("migdalor_assignments")
      .insert(fresh);
    if (e2) throw e2;
  }
  return fresh.length;
}
