// חותמטק: קונפיגורציה מרכזית. זה הקובץ היחיד שנוגעים בו בפריסה.

export const SUPABASE_URL = "https://ndrhiikczkbosentclnh.supabase.co";
export const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5kcmhpaWtjemtib3NlbnRjbG5oIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMzYwMzcsImV4cCI6MjA5NTkxMjAzN30.KpSEtEHI-i2TQDfuCf8l4Dg1wQ-Ya-UdLEQ6VN3KxEQ";

// כתובת ה-Worker של המוצר.
export const WORKER_URL = "https://migdalor.nirbosco-com-yotzer-education.workers.dev";

// שירות הניתוח החכם (פעימה 2, Google Cloud Function).
// ריק = הפיצ'ר מוסתר בממשק. מתמלא אחרי פריסת analysis/deploy.sh.
export const ANALYSIS_URL = "";

// איש הקשר האנושי שמופיע בכל מבוי סתום. מולא בהשקה (ראו SETUP.md).
export const CONTACT_NAME = "הצוות";
export const CONTACT_PHONE = "";

// גודל חלק בהעלאת multipart. מתחת למגבלת הגוף של ה-Worker (50MB),
// וגדול מהמינימום של R2 (5MB לכל חלק חוץ מהאחרון).
export const PART_SIZE = 25 * 1024 * 1024;

// יעדי ההקלטה, כפי שאומתו בספייק.
export const REC_TARGET = {
  width: 854,
  height: 480,
  videoBps: 1500000,
  audioBps: 96000,
  timesliceMs: 10000,
};

// מצב תצוגה (dev): ?dev=1 מדמה משתמש מחובר לצורך בדיקת ממשק בלבד.
// הוא לא עוקף שום הרשאה: כל פנייה אמיתית ל-Supabase נחסמת ממילא ב-RLS,
// והשכבה כאן רק מציגה נתוני הדגמה כדי שאפשר יהיה לראות את המסכים.
export const DEV = new URLSearchParams(location.search).has("dev");

// שומר את ?dev=1 במעבר בין דפים פנימיים.
export function devHref(href) {
  if (!DEV) return href;
  return href + (href.includes("?") ? "&" : "?") + "dev=1";
}
