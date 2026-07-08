// המגדלור: שכבת הנתונים. קליינט Supabase, התחברות, ושאילתות לכל המסכים.
// כל ההרשאות נאכפות ב-RLS בצד השרת; הקוד כאן רק שואל ומציג.
//
// מצב תצוגה (?dev=1): מדמה משתמש מחובר ומחזיר נתוני הדגמה קבועים,
// כדי שאפשר יהיה לבדוק את הממשק בלי חשבון גוגל. שום דבר לא נכתב לשרת,
// וגם אם היה נכתב, ה-RLS חוסם אנונימיים ממילא.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON, DEV } from "./config.js";

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
    viewedBy: ["אהוד (הדגמה)"],
    token: "dev-token-1",
  },
  {
    id: "dev-rec-2",
    title: "שיעור מיום שני, 6.7",
    duration_s: 1440,
    created_at: "2026-07-06T09:00:00Z",
    status: "ready",
    sharedWith: [],
    viewedBy: [],
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

// ---------- חותם: הקלטות, מנטורים, שיתופים ----------

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

// ההקלטות שלי, עם מי שותפו ומי צפה, מוכן לשורת הסטטוס האנושית.
export async function listMyRecordings() {
  if (DEV) return DEV_RECORDINGS;
  const user = await getUser();
  const { data: recs, error } = await supabase
    .from("migdalor_recordings")
    .select("id,title,duration_s,created_at,status")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  if (!recs.length) return [];

  const ids = recs.map((r) => r.id);
  const { data: shares } = await supabase
    .from("migdalor_shares")
    .select("id,recording_id,token,shared_with_email,revoked")
    .in("recording_id", ids)
    .eq("revoked", false);
  const shareIds = (shares || []).map((s) => s.id);
  let views = [];
  if (shareIds.length) {
    const { data: v } = await supabase
      .from("migdalor_views")
      .select("share_id,viewer_email")
      .in("share_id", shareIds);
    views = v || [];
  }
  // שמות המנטורים מרשימת השיבוץ (מותר לי לראות את המנטורים שלי)
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
    const viewedEmails = new Set(
      views
        .filter((v) => myShares.some((s) => s.id === v.share_id))
        .map((v) => v.viewer_email)
    );
    return {
      ...r,
      token: myShares.length ? myShares[0].token : null,
      sharedWith: recipients.map(
        (s) => names[s.shared_with_email] || s.shared_with_email
      ),
      viewedBy: recipients
        .filter((s) => viewedEmails.has(s.shared_with_email))
        .map((s) => names[s.shared_with_email] || s.shared_with_email),
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

  // שמות החותמים: דרך הפרופילים (מותר למנטור לראות את החותמים שלו)
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
      traineeName: owners[s.migdalor_recordings.owner_id] || "חותם",
      title: s.migdalor_recordings.title,
      duration_s: s.migdalor_recordings.duration_s,
      created_at: s.migdalor_recordings.created_at,
      viewedByMe: viewed.has(s.id),
    }));
}

// ---------- אדמין ----------

export async function adminOverview() {
  if (DEV) {
    return {
      trainees: [
        {
          email: "moshe.demo@example.com",
          full_name: "משה (הדגמה)",
          lastRecording: "2026-07-06T09:00:00Z",
          recordings: 2,
          shares: 1,
          viewed: 1,
        },
        {
          email: "sara.demo@example.com",
          full_name: "שרה (הדגמה)",
          lastRecording: null,
          recordings: 0,
          shares: 0,
          viewed: 0,
        },
      ],
      joinRequests: [
        {
          email: "new.demo@example.com",
          full_name: "יעקב (הדגמה)",
          phone: "050-0000000",
          created_at: "2026-07-07T08:00:00Z",
        },
      ],
      failedUploads: [],
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
  if (DEV) return;
  const { error } = await supabase
    .from("migdalor_roster")
    .upsert(rows, { onConflict: "email" });
  if (error) throw error;
}

// ---------- ניהול תפקידים (אדמין) ----------

const DEV_ROSTER = [
  { email: "moshe.demo@example.com", full_name: "משה (הדגמה)", role: "trainee" },
  { email: "sara.demo@example.com", full_name: "שרה (הדגמה)", role: "trainee" },
  { email: "ehud.demo@example.com", full_name: "אהוד (הדגמה)", role: "mentor" },
  { email: "nir.demo@example.com", full_name: "ניר (הדגמה)", role: "admin" },
];

// כל הרשומות ב-roster, ממוין לפי תפקיד ואז שם. לאדמין בלבד (roster_select).
export async function listRoster() {
  if (DEV) return [...DEV_ROSTER];
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
export async function upsertPerson({ email, full_name, role }) {
  if (DEV) return;
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
  if (DEV) return;
  const { error } = await supabase
    .from("migdalor_roster")
    .delete()
    .eq("email", (email || "").trim().toLowerCase());
  if (error) throw error;
}

export async function addAssignments(rows) {
  if (DEV) return;
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
