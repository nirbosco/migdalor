// חותמטק: הניתוח החכם בצד הלקוח (פעימה 2).
// שני תוצרים מאותו צינור: משוב אמפתי לחותמיסט, ניתוח אבחוני עמוק למוביל הבית.
// הקליינט רק מבקש ומציג; כל ההרשאות נאכפות בשרת (RLS + שירות הניתוח).

import { ANALYSIS_URL, DEV } from "./config.js";
import { supabase, getAccessToken } from "./supa.js";

export const analysisEnabled = () => DEV || !!ANALYSIS_URL;

const SPOT_NAMES = {
  1: "עניין ורלוונטיות",
  2: "אחריות ובחירה",
  3: "דיפרנציאליות וגיוון",
  4: "שיתופיות בלמידה",
  5: "הערכה ורפלקטיביות",
};

// ---------- נתוני הדגמה (?dev=1) ----------

const DEV_FEEDBACK = {
  opening: "כל הכבוד על השיעור! ניכר שהכנת אותו בקפידה, והאווירה בכיתה חמה ומזמינה.",
  strengths: [
    { spotlight: 4, what: "הדיון בזוגות אחרי השאלה הפתוחה", moment: "07:40",
      why: "נתת לתלמידים לבנות ידע יחד לפני שסיכמת. זה לב השיתופיות" },
  ],
  next_steps: [
    { spotlight: 2, idea: "לתת לתלמידים לבחור בין שתי דרכי תרגול",
      how: "בפעם הבאה, אחרי ההסבר, להציע: מי שרוצה פותר בכתב, מי שרוצה מסביר לחבר" },
  ],
  closing: "יש כאן בסיס חזק. הצעד הקטן הבא יעשה הבדל גדול.",
};

const DEV_REPORT = {
  summary: "שיעור מובנה ובטוח, עם שליטה כיתתית טובה. עיקר הדיבור אצל המורה; רגעי השיתופיות חזקים אך קצרים.",
  spotlights: [
    { spotlight: 1, name: SPOT_NAMES[1], level: "בינוני",
      evidence: [{ moment: "02:10", desc: "פתיחה עם דוגמה מחיי התלמידים" }],
      strengths: "חיבור יפה לעולם התלמידים בפתיחה", watch_points: "החיבור לא חזר אחרי הפתיחה", red_flags: null },
    { spotlight: 4, name: SPOT_NAMES[4], level: "חזק",
      evidence: [{ moment: "07:40", desc: "דיון בזוגות יזום" }],
      strengths: "דיון זוגות אמיתי עם משימה ברורה", watch_points: "לשקול איסוף תובנות במליאה", red_flags: null },
    { spotlight: 5, name: SPOT_NAMES[5], level: "לא נצפה", evidence: [],
      strengths: "", watch_points: "אין רגע רפלקטיבי בשיעור",
      red_flags: "השיעור מסתיים בלי שום בדיקת הבנה. אין למורה דרך לדעת מי הבין" },
  ],
  top_strengths: ["ניהול כיתה רגוע", "דיון זוגות איכותי"],
  top_improvements: ["בדיקת הבנה לפני הסיום", "הפחתת דיבור מורה רציף"],
  talking_points: ["איך נדע מי הבין? לחשוב יחד על טקס סיום קצר"],
};

// ---------- בקשה ומעקב ----------

export async function requestAnalysis(recordingId) {
  if (DEV) return { ok: true, status: "ready" };
  const jwt = await getAccessToken();
  const res = await fetch(ANALYSIS_URL, {
    method: "POST",
    headers: { authorization: "Bearer " + jwt, "content-type": "application/json" },
    body: JSON.stringify({ recordingId }),
  });
  // גם אם החיבור נקטע, השירות ממשיך; ה-polling יגלה את התוצאה
  return res.json().catch(() => ({ ok: true, status: "analyzing" }));
}

export async function getAnalysis(recordingId) {
  if (DEV) return { status: "ready", trainee_feedback: DEV_FEEDBACK };
  const { data } = await supabase
    .from("migdalor_analyses")
    .select("status,trainee_feedback,error,updated_at")
    .eq("recording_id", recordingId)
    .maybeSingle();
  return data;
}

export async function getMentorReport(recordingId) {
  if (DEV) return { report: DEV_REPORT };
  const { data } = await supabase
    .from("migdalor_mentor_reports")
    .select("report")
    .eq("recording_id", recordingId)
    .maybeSingle();
  return data;
}

// polling עדין: כל 5 שניות, עד 30 דקות. onTick מקבל את הסטטוס להצגה.
export async function waitForAnalysis(recordingId, onTick) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const row = await getAnalysis(recordingId);
    if (row && onTick) onTick(row.status);
    if (row && row.status === "ready") return row;
    if (row && row.status === "failed") throw new Error(row.error || "הניתוח נכשל");
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error("הניתוח לוקח יותר מדי זמן. אפשר לחזור לכאן מאוחר יותר");
}

// ---------- תצוגה ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// תג רגע: לחיצה מקפיצה את הנגן לנקודה
function momentTag(moment) {
  if (!moment) return "";
  return `<span class="ai-moment" data-t="${esc(moment)}">${esc(moment)} ⏱</span>`;
}

export function wireMoments(panel, video) {
  panel.querySelectorAll(".ai-moment").forEach((el) => {
    el.addEventListener("click", () => {
      const [m, s] = el.dataset.t.split(":").map(Number);
      if (video && !isNaN(m)) {
        video.currentTime = m * 60 + (s || 0);
        video.play().catch(() => {});
        video.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

export function renderTraineeFeedback(fb) {
  const strengths = (fb.strengths || [])
    .map(
      (s) => `<div class="ai-card">
        <h3>מה עבד: ${esc(SPOT_NAMES[s.spotlight] || "")} ${momentTag(s.moment)}</h3>
        <p>${esc(s.what)}</p><p class="small">${esc(s.why || "")}</p></div>`
    )
    .join("");
  const steps = (fb.next_steps || [])
    .map(
      (s) => `<div class="ai-card">
        <h3>צעד קדימה: ${esc(SPOT_NAMES[s.spotlight] || "")}</h3>
        <p>${esc(s.idea)}</p><p class="small">${esc(s.how || "")}</p></div>`
    )
    .join("");
  return `<div class="ai-card"><p class="ai-open">${esc(fb.opening || "")}</p></div>
    ${strengths}${steps}
    <div class="ai-card"><p class="ai-open">${esc(fb.closing || "")}</p></div>
    <p class="small mt">המשוב הופק אוטומטית מתוך תמלול השיעור, לפי מודל המגדלור. הוא כלי לחשיבה, לא ציון.</p>`;
}

const LEVEL_CLS = { "חזק": "strong", "בינוני": "mid", "חלש": "weak", "לא נצפה": "none" };

export function renderMentorReport(rep) {
  const spots = (rep.spotlights || [])
    .map((s) => {
      const ev = (s.evidence || [])
        .map((e) => `<li>${momentTag(e.moment)} ${esc(e.desc)}</li>`)
        .join("");
      return `<div class="ai-card ${s.red_flags ? "ai-red" : ""}">
        <h3>${esc(s.name || SPOT_NAMES[s.spotlight] || "")}
          <span class="ai-level ${LEVEL_CLS[s.level] || "none"}">${esc(s.level || "")}</span></h3>
        ${ev ? `<ul>${ev}</ul>` : ""}
        ${s.strengths ? `<p><strong>חוזקות:</strong> ${esc(s.strengths)}</p>` : ""}
        ${s.watch_points ? `<p><strong>לתשומת לב:</strong> ${esc(s.watch_points)}</p>` : ""}
        ${s.red_flags ? `<p><strong>נקודה אדומה:</strong> ${esc(s.red_flags)}</p>` : ""}
      </div>`;
    })
    .join("");
  const list = (arr) => (arr || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return `<div class="ai-card"><h3>תמונת מצב</h3><p>${esc(rep.summary || "")}</p></div>
    ${spots}
    <div class="ai-card"><h3>סיכום למוביל הבית</h3>
      <p><strong>חוזקות מובילות:</strong></p><ul>${list(rep.top_strengths)}</ul>
      <p><strong>שיפורים מובילים:</strong></p><ul>${list(rep.top_improvements)}</ul>
      <p><strong>לשיחה עם החותמיסט:</strong></p><ul>${list(rep.talking_points)}</ul></div>
    <p class="small mt">הניתוח הופק אוטומטית מתוך תמלול בלבד (בלי וידאו), לפי מודל המגדלור. שיקול הדעת שלך מעליו.</p>`;
}
