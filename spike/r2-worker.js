// ספייק המגדלור, חלק ב (גרסת R2): Cloudflare Worker אחד שגם קולט העלאה
// וגם מזרים וידאו מ-Cloudflare R2, עם תמיכה מלאה ב-Range (דילוג בציר הזמן).
// R2 הוא object storage אמיתי, ולכן זה קצר ופשוט בהרבה ממסלול הדרייב: אין JWT,
// אין חשבון שירות, רק binding לדלי.
//
// פריסה (הכול בדשבורד של Cloudflare, בלי כלים בטרמינל):
// 1. R2 > Create bucket, בשם: migdalor-spike
// 2. Workers & Pages > Create > Worker, להדביק את הקובץ הזה.
// 3. ב-Worker: Settings > Bindings > Add > R2 bucket:
//    Variable name: BUCKET   |   Bucket: migdalor-spike
// 4. ב-Worker: Settings > Variables and Secrets > Add secret:
//    SPIKE_TOKEN = מחרוזת אקראית ארוכה (הטוקן לבדיקה)
// 5. Deploy. הכתובת: https://<worker-name>.<subdomain>.workers.dev
//
// שימוש:
//   העלאה:  PUT  https://<worker>/u/<key>?t=<TOKEN>   גוף הבקשה = קובץ הווידאו
//   צפייה:  GET  https://<worker>/v/<key>?t=<TOKEN>   (הכתובת שמדביקים ב-player.html)
// <key> הוא שם חופשי לקובץ, למשל  test1.webm
//
// הערה: זה קוד ספייק, טוקן סטטי. במערכת האמיתית הטוקן ייבדק מול Supabase
// (מי המשתמש, מה שותף איתו), לא מול סוד יחיד.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // preflight של הדפדפן לפני העלאה חוצת-מקור
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.searchParams.get("t") !== env.SPIKE_TOKEN) {
      return new Response("אין לך גישה לשיעור הזה", {
        status: 403, headers: { "content-type": "text/plain; charset=utf-8", ...CORS }
      });
    }

    const up = url.pathname.match(/^\/u\/(.+)$/);
    const view = url.pathname.match(/^\/v\/(.+)$/);

    // ---- העלאה ----
    if (up && request.method === "PUT") {
      const key = decodeURIComponent(up[1]);
      const obj = await env.BUCKET.put(key, request.body, {
        httpMetadata: { contentType: request.headers.get("content-type") || "video/webm" }
      });
      return Response.json({ ok: true, key, size: obj.size }, { headers: CORS });
    }

    // ---- צפייה עם Range ----
    if (view && request.method === "GET") {
      const key = decodeURIComponent(view[1]);
      const range = request.headers.get("range");
      let opts = {};
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const offset = parseInt(m[1]);
          const end = m[2] ? parseInt(m[2]) : undefined;
          opts = { range: end !== undefined ? { offset, length: end - offset + 1 } : { offset } };
        }
      }
      const obj = await env.BUCKET.get(key, opts);
      if (!obj) return new Response("not found", { status: 404 });

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("accept-ranges", "bytes");
      headers.set("cache-control", "private, no-store");
      headers.set("etag", obj.httpEtag);

      headers.set("access-control-allow-origin", "*");
      if (range && obj.range) {
        const total = obj.size;
        const start = obj.range.offset || 0;
        const len = obj.range.length || (total - start);
        headers.set("content-range", `bytes ${start}-${start + len - 1}/${total}`);
        headers.set("content-length", String(len));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set("content-length", String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    }

    return new Response("migdalor spike R2 worker", { status: 200 });
  }
};
