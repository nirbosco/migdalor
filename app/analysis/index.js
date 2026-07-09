// חותמטק: שירות הניתוח החכם (פעימה 2). Google Cloud Function (gen2).
//
// זה השירות המהימן היחיד: רק כאן יושבים המפתחות (Anthropic, Supabase service,
// חשבון השירות של Google STT מגיע אוטומטית מזהות ה-Function).
// הקליינט קורא POST /analyze עם JWT של המשתמש; ההרשאה נבדקת מול Supabase
// בדיוק כמו ב-Worker: בעלים, מנטור-עם-שיתוף או אדמין.
//
// הצינור: וידאו מ-R2 (דרך ה-Worker הקיים, עם ה-JWT של המבקש) → GCS זמני →
// Google Speech-to-Text (עברית, WEBM_OPUS, חותמות זמן) → Claude פעמיים
// (משוב אמפתי לחותמיסט + ניתוח אבחוני למנטור) → כתיבה ל-Supabase (service key).
//
// משתני סביבה נדרשים בפריסה:
//   SUPABASE_URL, SUPABASE_ANON, SUPABASE_SERVICE_KEY,
//   ANTHROPIC_API_KEY, WORKER_URL, GCS_TEMP_BUCKET

const functions = require("@google-cloud/functions-framework");
const { Storage } = require("@google-cloud/storage");
const speech = require("@google-cloud/speech");

const storage = new Storage();
const speechClient = new speech.SpeechClient();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

// ---------- הגדרות הזרקורים (מתוך מודל המגדלור, מילה במילה מהתמצית) ----------

const SPOTLIGHTS = `חמשת זרקורי המגדלור (מודל פדגוגי של חותם, מבוסס הבניית ידע):
1. עניין ללומד/ת ורלוונטיות לעולמו/ה: מפגש משמעותי בין תכני הלמידה לקולם האישי של הלומדים, לידע שלהם ולעולמם החברתי או התרבותי.
2. אחריות ובחירה של הלומד/ת: הזדמנויות להתנסות בבחירה, תרגול אחריות, עצמאות וחוויית מסוגלות.
3. דיפרנציאליות וגיוון בדרכי ההוראה והלמידה: התייחסות למגוון ולצרכים הייחודיים של כל לומד, השתתפות משמעותית של כולם.
4. שיתופיות בלמידה: למידה מעוגנת בדיאלוגים וביחסים בין הלומדים; אינטראקציות של שיתוף, החלפת ידע ובניית ידע חדש.
5. הערכה ורפלקטיביות: הערכת תהליכי הלמידה ותוצריה, התבוננות רפלקטיבית של התלמידים והמורה כרכיב מהותי בתהליך.

כללי המשוב של חותם: משוב חיובי (מה עבד, מה לשמר) ומשוב בונה (מה אפשר לשפר, מה הצעד הבא), תמיד מעוגן ברגעים ספציפיים.`;

const TRAINEE_SYSTEM = `אתה מלווה פדגוגי ברוח חותם. לפניך תמלול שיעור שהמורה צילם/ה את עצמו/ה מיוזמתו/ה כדי להשתפר. תפקידך להחזיר משוב אישי, אמפתי, כן ובונה. לא מחמיא סתם ולא שיפוטי.

כללים מחייבים:
- עגן כל אמירה ברגע ספציפי מהתמלול (חותמת זמן mm:ss).
- בחר 1-2 חוזקות אמיתיות ו-1-2 צעדים קדימה בלבד. משוב שמציף מרתיע, לא מפתח.
- דבר בגוף שני, בחום ובכבוד, בעברית תקנית ופשוטה.
- אל תמציא דבר שלא מופיע בתמלול. זרקור שלא בא לידי ביטוי, אל תכתוב עליו.
- זכור: אתה רואה תמלול בלבד, לא וידאו. אל תתייחס לשפת גוף או לנעשה בכיתה שלא נשמע.

${SPOTLIGHTS}

החזר JSON בלבד במבנה:
{"opening": "משפט פתיחה חם ואישי שמכיר במאמץ",
 "strengths": [{"spotlight": <1-5>, "what": "מה עבד", "moment": "mm:ss", "why": "למה זה משמעותי לפי המגדלור"}],
 "next_steps": [{"spotlight": <1-5>, "idea": "רעיון קונקרטי אחד", "how": "איך לנסות בשיעור הבא"}],
 "closing": "משפט סיום מעודד ואמיתי"}`;

const MENTOR_SYSTEM = `אתה אנליסט פדגוגי בכיר ברוח חותם. לפניך תמלול שיעור של מורה בהכשרה. תפקידך להפיק ניתוח אבחוני עמוק למנטור שמלווה את המורה: ישיר, מדויק, בלי ליפוף.

כללים מחייבים:
- עבור כל אחד מחמשת הזרקורים: עדות מהתמלול (חותמות זמן mm:ss), רמת ביטוי, חוזקות, נקודות לתשומת לב, ונקודות אדומות אם יש (החמצה משמעותית, פגיעה בעיקרון קונסטרוקטיביסטי, אי-שוויון בהשתתפות, דיבור מורה גורף על חשבון קול תלמידים).
- אל תמציא. מה שלא נצפה בתמלול, סמן "לא נצפה" ואל תסיק ממנו שלילה.
- אתה רואה תמלול בלבד, לא וידאו. סייג בהתאם.
- בנוסף נסח mentor_note_draft: טיוטת משוב לחותמיסט בטון בונה ואמפתי, שהמנטור יערוך לפני שליחה.

${SPOTLIGHTS}

החזר JSON בלבד במבנה:
{"summary": "פסקת אבחון קצרה: מה מאפיין את ההוראה בשיעור הזה",
 "spotlights": [{"spotlight": <1-5>, "name": "שם הזרקור",
   "level": "חזק" | "בינוני" | "חלש" | "לא נצפה",
   "evidence": [{"moment": "mm:ss", "desc": "מה קרה"}],
   "strengths": "מה עבד בזרקור הזה", "watch_points": "נקודות לתשומת לב",
   "red_flags": "נקודות אדומות, או null"}],
 "top_strengths": ["עד 3"], "top_improvements": ["עד 3"],
 "talking_points": ["נקודות לשיחת המנטור עם החותמיסט"],
 "mentor_note_draft": "טיוטת משוב לחותמיסט, 4-8 משפטים, גוף שני, חם ובונה"}`;

// ---------- עזרי Supabase ----------

function serviceHeaders() {
  return {
    apikey: process.env.SUPABASE_SERVICE_KEY,
    authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

async function supaService(pathAndQuery, { method = "GET", body } = {}) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { ...serviceHeaders(), prefer: "resolution=merge-duplicates,return=representation" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`supabase ${method} ${pathAndQuery}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function getUser(jwt) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${jwt}`, apikey: process.env.SUPABASE_ANON },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return user && user.id ? user : null;
}

// הרשאה: השאילתה רצה עם ה-JWT של המשתמש, כך ש-RLS מכריע.
// אם השורה חוזרת, למשתמש יש גישה להקלטה (בעלים, מנטור-עם-שיתוף או אדמין).
async function getAccessibleRecording(recordingId, jwt) {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/migdalor_recordings?id=eq.${recordingId}` +
      `&select=id,owner_id,title,duration_s,mime,storage_key,status`,
    { headers: { apikey: process.env.SUPABASE_ANON, authorization: `Bearer ${jwt}` } }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

async function setStatus(recordingId, fields) {
  await supaService(`migdalor_analyses?recording_id=eq.${recordingId}`, {
    method: "PATCH",
    body: { ...fields, updated_at: new Date().toISOString() },
  });
}

// ---------- הצינור ----------

async function fetchVideo(recording, user, jwt) {
  // מושכים דרך ה-Worker הקיים: אותה בדיקת הרשאה, בלי מפתחות R2 כאן.
  const base = process.env.WORKER_URL;
  let url;
  if (recording.owner_id === user.id) {
    url = `${base}/mine/${recording.id}?auth=${encodeURIComponent(jwt)}`;
  } else {
    // מנטור/אדמין: צריך טוקן שיתוף. שולפים אותו עם service key.
    const shares = await supaService(
      `migdalor_shares?recording_id=eq.${recording.id}&revoked=eq.false&select=token&limit=1`
    );
    if (!shares.length) throw new Error("אין שיתוף פעיל להקלטה");
    url = `${base}/v/${recording.id}?token=${encodeURIComponent(shares[0].token)}&auth=${encodeURIComponent(jwt)}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`משיכת וידאו נכשלה: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe(recordingId, videoBuf, mime) {
  // מעלים ל-GCS זמני (חובה לאודיו ארוך מדקה), מתמללים, מוחקים.
  const bucket = storage.bucket(process.env.GCS_TEMP_BUCKET);
  const ext = (mime || "").includes("mp4") ? "mp4" : "webm";
  const objName = `tmp/${recordingId}.${ext}`;
  const file = bucket.file(objName);
  await file.save(videoBuf, { resumable: videoBuf.length > 5 * 1024 * 1024 });
  try {
    const encoding = ext === "webm" ? "WEBM_OPUS" : "ENCODING_UNSPECIFIED";
    const [op] = await speechClient.longRunningRecognize({
      config: {
        encoding,
        sampleRateHertz: ext === "webm" ? 48000 : undefined,
        languageCode: "he-IL",
        enableWordTimeOffsets: true,
        enableAutomaticPunctuation: true,
        model: "latest_long",
      },
      audio: { uri: `gs://${process.env.GCS_TEMP_BUCKET}/${objName}` },
    });
    const [response] = await op.promise();
    const segments = [];
    for (const r of response.results || []) {
      const alt = r.alternatives && r.alternatives[0];
      if (!alt || !alt.transcript) continue;
      const firstWord = alt.words && alt.words[0];
      const t = firstWord ? Number(firstWord.startTime.seconds || 0) : 0;
      segments.push({ t, text: alt.transcript.trim() });
    }
    return { language: "he-IL", segments };
  } finally {
    await file.delete({ ignoreNotFound: true });
  }
}

function transcriptText(transcript) {
  return transcript.segments
    .map((s) => {
      const m = String(Math.floor(s.t / 60)).padStart(2, "0");
      const sec = String(Math.floor(s.t % 60)).padStart(2, "0");
      return `[${m}:${sec}] ${s.text}`;
    })
    .join("\n");
}

async function askClaude(system, userContent) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  // מחלצים JSON גם אם עטוף בגדר קוד
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude החזיר פלט לא צפוי");
  return JSON.parse(m[0]);
}

// ---------- נקודת הכניסה ----------

functions.http("analyze", async (req, res) => {
  for (const [k, v] of Object.entries(CORS)) res.set(k, v);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).json({ error: "POST בלבד" });

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { recordingId } = req.body || {};
  if (!jwt || !recordingId) return res.status(400).json({ error: "recordingId או הרשאה חסרים" });

  const user = await getUser(jwt);
  if (!user) return res.status(401).json({ error: "נדרשת כניסה" });

  const recording = await getAccessibleRecording(recordingId, jwt);
  if (!recording) return res.status(403).json({ error: "אין גישה להקלטה" });
  if (recording.status !== "ready") return res.status(409).json({ error: "ההקלטה עדיין לא מוכנה" });

  // אם כבר יש ניתוח מוכן, לא מריצים שוב (חוסך עלות)
  const existing = await supaService(
    `migdalor_analyses?recording_id=eq.${recordingId}&select=status`
  );
  if (existing.length && existing[0].status === "ready") {
    return res.status(200).json({ ok: true, status: "ready" });
  }
  if (existing.length && ["transcribing", "analyzing"].includes(existing[0].status)) {
    return res.status(200).json({ ok: true, status: existing[0].status });
  }

  // שורת מצב (upsert): מכאן הקליינט עוקב ב-polling
  await supaService("migdalor_analyses?on_conflict=recording_id", {
    method: "POST",
    body: {
      recording_id: recordingId,
      status: "transcribing",
      requested_by: user.id,
      error: null,
    },
  });

  try {
    const videoBuf = await fetchVideo(recording, user, jwt);
    const transcript = await transcribe(recordingId, videoBuf, recording.mime);
    if (!transcript.segments.length) throw new Error("התמלול חזר ריק. ייתכן שאין דיבור ברור בהקלטה");
    await setStatus(recordingId, { status: "analyzing", transcript });

    const text = transcriptText(transcript);
    const userMsg =
      `תמלול השיעור "${recording.title || "ללא שם"}" (משך ${Math.round(
        (recording.duration_s || 0) / 60
      )} דקות):\n\n${text}`;

    const [traineeFeedback, mentorReport] = await Promise.all([
      askClaude(TRAINEE_SYSTEM, userMsg),
      askClaude(MENTOR_SYSTEM, userMsg),
    ]);

    const { mentor_note_draft, ...report } = mentorReport;
    await supaService("migdalor_mentor_reports?on_conflict=recording_id", {
      method: "POST",
      body: {
        recording_id: recordingId,
        report,
        mentor_note_draft: mentor_note_draft || "",
        updated_at: new Date().toISOString(),
      },
    });
    await setStatus(recordingId, {
      status: "ready",
      trainee_feedback: traineeFeedback,
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
    });
    return res.status(200).json({ ok: true, status: "ready" });
  } catch (e) {
    await setStatus(recordingId, { status: "failed", error: String(e.message || e) });
    return res.status(500).json({ error: String(e.message || e) });
  }
});
