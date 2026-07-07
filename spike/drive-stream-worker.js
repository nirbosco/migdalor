// ספייק המגדלור, חלק ב, צעד 2: Cloudflare Worker שמזרים וידאו מגוגל דרייב
// עם העברת Range מלאה (דילוג בציר הזמן) ובדיקת טוקן בסיסית.
//
// פריסה (דרך הדשבורד של Cloudflare, בלי כלים נוספים):
// 1. Workers & Pages > Create > Worker, להדביק את הקובץ הזה.
// 2. Settings > Variables and Secrets, להוסיף שלושה Secrets:
//    SA_EMAIL     כתובת המייל של חשבון השירות
//    SA_KEY       ה-private_key מקובץ ה-JSON (כולל שורות BEGIN/END, עם \n כמו שהוא)
//    SPIKE_TOKEN  מחרוזת אקראית ארוכה שתשמש כטוקן הבדיקה
// 3. כתובת הבדיקה: https://<worker>.workers.dev/v/<fileId>?t=<SPIKE_TOKEN>
//
// הערה לזמן אמת: זה קוד ספייק. במערכת האמיתית הטוקן ייבדק מול Supabase
// (מי משתמש, מה שותף איתו), לא מול סוד סטטי.

let cachedToken = null;
let cachedUntil = 0;

function pemToArrayBuffer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

function b64url(data) {
  const str = typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data));
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function accessToken(env) {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: env.SA_EMAIL,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600
  }));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToArrayBuffer(env.SA_KEY),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const unsigned = header + "." + claims;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = unsigned + "." + b64url(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("token failed: " + JSON.stringify(j));
  cachedToken = j.access_token;
  cachedUntil = Date.now() + (j.expires_in - 120) * 1000;
  return cachedToken;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/v\/([\w-]+)$/);
    if (!m) return new Response("migdalor spike worker", { status: 200 });
    if (url.searchParams.get("t") !== env.SPIKE_TOKEN) {
      return new Response("אין לך גישה לשיעור הזה", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const token = await accessToken(env);
    const headers = { authorization: "Bearer " + token };
    const range = request.headers.get("range");
    if (range) headers.range = range;
    const drive = await fetch(
      `https://www.googleapis.com/drive/v3/files/${m[1]}?alt=media&supportsAllDrives=true`,
      { headers }
    );
    if (!drive.ok && drive.status !== 206) {
      return new Response("drive error " + drive.status + ": " + await drive.text(), { status: 502 });
    }
    const out = new Headers();
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag"]) {
      const v = drive.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
    out.set("cache-control", "private, no-store");
    return new Response(drive.body, { status: drive.status, headers: out });
  }
};
