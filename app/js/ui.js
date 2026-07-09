// חותמטק: עזרי ממשק משותפים. עברית, תאריכים בשפת בני אדם, מעבר מסכים.

const WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

export function $(id) {
  return document.getElementById(id);
}

export function show(el, on = true) {
  el.classList.toggle("hidden", !on);
}

// מעבר מסכים ב-SPA: מציג מסך אחד ומכבה את השאר.
export function goScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => {
    s.classList.toggle("active", s.id === id);
  });
  window.scrollTo(0, 0);
}

// "שיעור מיום שלישי, 7.7"
export function defaultLessonName(d = new Date()) {
  return `שיעור מיום ${WEEKDAYS[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}`;
}

// "יום שלישי, 7.7" לתצוגת כרטיסים
export function humanDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return `יום ${WEEKDAYS[d.getDay()]}, ${d.getDate()}.${d.getMonth() + 1}`;
}

// משך בדקות בשפת בני אדם: "43 דקות" / "דקה אחת" / "פחות מדקה"
export function humanMinutes(seconds) {
  const m = Math.round((seconds || 0) / 60);
  if (m <= 0) return "פחות מדקה";
  if (m === 1) return "דקה אחת";
  return `${m} דקות`;
}

// שעון הקלטה MM:SS (או HH:MM:SS מעל שעה)
export function clock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// "בדקה 22" לזכירת נקודת עצירה
export function atMinute(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 1) return "בהתחלה";
  return `בדקה ${m}`;
}

// חיבור רשימת שמות: "אהוד", "אהוד ורות", "אהוד, רות ודנה"
export function joinNames(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " ו" + names[names.length - 1];
}

// זיהוי דפדפן פנימי של וואטסאפ (ושאר דפדפני in-app שחוסמים מצלמה)
export function isInAppBrowser() {
  const ua = navigator.userAgent || "";
  return /WhatsApp|FBAN|FBAV|Instagram|Line\//i.test(ua);
}

// חיווי אופליין גלובלי על גוף הדף
export function watchOnline(onChange) {
  const apply = () => {
    document.body.classList.toggle("offline", !navigator.onLine);
    if (onChange) onChange(navigator.onLine);
  };
  window.addEventListener("online", apply);
  window.addEventListener("offline", apply);
  apply();
}

// העתקה ללוח עם נפילה חיננית לדפדפנים ישנים
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e2) {
      return false;
    }
  }
}
