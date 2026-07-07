// המגדלור: ה-Worker של המוצר (פעימה 1). מחליף את worker הספייק.
//
// מה הוא עושה:
//   1. העלאת multipart ל-R2, עם אימות משתמש ובדיקת בעלות מול Supabase.
//   2. הזרמת צפייה עם Range מלא, אחרי בדיקת הרשאה בשרת:
//      רק הנמען, הבעלים או אדמין. לכל אחד אחר: 403.
//   3. רישום צפיות דרך פונקציית שרת (רק נמענים, פעם ביום).
//
// ארכיטקטורת אבטחה: ל-Worker אין שום סוד. כל בקשה נושאת את ה-JWT של
// המשתמש (מכותרת Authorization או, בנגן הווידאו, מפרמטר auth בכתובת),
// וההרשאות נאכפות בשני מקומות: RLS על הטבלאות, ופונקציות security definer
// ממוקדות (migdalor_share_lookup / migdalor_can_view / migdalor_log_view).
//
// הגדרות נדרשות בפריסה (ראו SETUP.md):
//   Variables (רגילים, לא סודות):
//     SUPABASE_URL   למשל https://ndrhiikczkbosentclnh.supabase.co
//     SUPABASE_ANON  מפתח ה-anon (ציבורי ממילא)
//   Bindings:
//     BUCKET         R2 bucket (הדלי של הסרטונים)
//
// נתיבים:
//   POST /upload/create    { recordingId, mime }        -> { key, uploadId }
//   PUT  /upload/part?key=..&uploadId=..&part=N          -> { etag, part }
//   POST /upload/complete  { recordingId, key, uploadId, parts, sizeBytes }
//   GET  /meta?token=..                                  -> פרטי השיעור לצופה מורשה
//   GET  /v/<recordingId>?token=..&auth=<jwt>            -> הזרמת הווידאו (Range)
//   POST /viewed           { token }                     -> רישום צפייה

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, range",
  "access-control-expose-headers": "content-range, content-length, accept-ranges, etag",
  "access-control-max-age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });
}

function deny(msg = "אין לך גישה לשיעור הזה", status = 403) {
  return new Response(msg, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...CORS },
  });
}

// ---------- Supabase REST בהרשאות המשתמש (RLS אוכף) ----------

async function supa(env, pathAndQuery, { method = "GET", jwt = "", body } = {}) {
  const headers = {
    apikey: env.SUPABASE_ANON,
    authorization: `Bearer ${jwt || env.SUPABASE_ANON}`,
    "content-type": "application/json",
  };
  if (method === "PATCH") headers.prefer = "return=minimal";
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`supabase ${method} ${pathAndQuery}: ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rpc(env, fn, args, jwt = "") {
  return supa(env, `rpc/${fn}`, { method: "POST", jwt, body: args });
}

// ---------- אימות המשתמש מול Supabase Auth ----------

const userCache = new Map(); // jwt -> { user, until }

async function getAuth(request, url, env) {
  let jwt = "";
  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Bearer ")) jwt = header.slice(7);
  if (!jwt) jwt = url.searchParams.get("auth") || "";
  if (!jwt) return { user: null, jwt: "" };

  const cached = userCache.get(jwt);
  if (cached && cached.until > Date.now()) return { user: cached.user, jwt };

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: `Bearer ${jwt}`, apikey: env.SUPABASE_ANON },
  });
  if (!res.ok) return { user: null, jwt: "" };
  const user = await res.json();
  if (!user || !user.id) return { user: null, jwt: "" };
  userCache.set(jwt, { user, until: Date.now() + 60000 });
  if (userCache.size > 500) userCache.clear();
  return { user, jwt };
}

// ---------- בדיקת הרשאת צפייה ----------

async function checkViewAccess(env, token, user, jwt) {
  if (!token) return { ok: false };
  const rows = await rpc(env, "migdalor_share_lookup", { p_token: token });
  if (!rows || !rows.length) return { ok: false, notFound: true };
  const r = rows[0];
  const recording = {
    id: r.recording_id,
    owner_id: r.owner_id,
    title: r.title,
    duration_s: r.duration_s,
    mime: r.mime,
    storage_key: r.storage_key,
    status: r.status,
    created_at: r.created_at,
    owner_name: r.owner_name || r.owner_email || "",
  };
  if (!user) return { ok: false };
  const allowed = await rpc(env, "migdalor_can_view", { p_token: token }, jwt);
  if (!allowed) return { ok: false };
  return { ok: true, recording };
}

// ---------- העלאה ----------

function extFor(mime) {
  if ((mime || "").includes("mp4")) return "mp4";
  if ((mime || "").includes("webm")) return "webm";
  return "bin";
}

async function handleUploadCreate(request, env, user, jwt) {
  const { recordingId, mime } = await request.json();
  if (!recordingId) return json({ error: "recordingId חסר" }, 400);
  // RLS: המשתמש רואה רק הקלטות שלו (או שהוא אדמין); דורשים בעלות מפורשת
  const recs = await supa(
    env,
    `migdalor_recordings?id=eq.${recordingId}&select=id,owner_id,mime`,
    { jwt }
  );
  if (!recs.length) return deny("ההקלטה לא נמצאה", 404);
  if (recs[0].owner_id !== user.id) return deny();

  const key = `recordings/${user.id}/${recordingId}.${extFor(mime || recs[0].mime)}`;
  const upload = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: (mime || recs[0].mime || "video/webm").split(";")[0] },
  });
  await supa(env, `migdalor_recordings?id=eq.${recordingId}`, {
    method: "PATCH",
    jwt,
    body: { storage_key: key, status: "uploading" },
  });
  return json({ key, uploadId: upload.uploadId });
}

async function handleUploadPart(request, url, env, user) {
  const key = url.searchParams.get("key") || "";
  const uploadId = url.searchParams.get("uploadId") || "";
  const part = parseInt(url.searchParams.get("part") || "0", 10);
  if (!key || !uploadId || !part) return json({ error: "פרמטרים חסרים" }, 400);
  // בדיקת בעלות זולה: המפתח כולל את מזהה הבעלים
  if (!key.startsWith(`recordings/${user.id}/`)) return deny();
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  try {
    const res = await upload.uploadPart(part, request.body);
    return json({ etag: res.etag, part });
  } catch (e) {
    // סשן שפג או לא קיים: הלקוח יפתח סשן חדש וימשיך
    return json({ error: String(e.message || e) }, 404);
  }
}

async function handleUploadComplete(request, env, user, jwt) {
  const { recordingId, key, uploadId, parts, sizeBytes } = await request.json();
  if (!recordingId || !key || !uploadId || !Array.isArray(parts) || !parts.length) {
    return json({ error: "פרמטרים חסרים" }, 400);
  }
  if (!key.startsWith(`recordings/${user.id}/`)) return deny();
  const upload = env.BUCKET.resumeMultipartUpload(key, uploadId);
  try {
    await upload.complete(
      parts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
    );
  } catch (e) {
    return json({ error: String(e.message || e) }, 404);
  }
  await supa(env, `migdalor_recordings?id=eq.${recordingId}`, {
    method: "PATCH",
    jwt,
    body: { status: "ready", size_bytes: sizeBytes || null },
  });
  return json({ ok: true });
}

// ---------- צפייה ----------

async function handleStream(request, url, env, recordingId) {
  const token = url.searchParams.get("token") || "";
  const { user, jwt } = await getAuth(request, url, env);
  const access = await checkViewAccess(env, token, user, jwt);
  if (!access.ok) {
    return access.notFound ? deny("השיעור לא נמצא", 404) : deny();
  }
  if (access.recording.id !== recordingId) return deny();
  if (!access.recording.storage_key || access.recording.status !== "ready") {
    return deny("הסרטון עדיין עולה", 409);
  }

  const range = request.headers.get("range");
  let opts = {};
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1]);
      const end = m[2] ? parseInt(m[2]) : undefined;
      opts = {
        range: end !== undefined ? { offset, length: end - offset + 1 } : { offset },
      };
    }
  }
  const obj = await env.BUCKET.get(access.recording.storage_key, opts);
  if (!obj) return deny("השיעור לא נמצא", 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("etag", obj.httpEtag);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);

  if (range && obj.range) {
    const total = obj.size;
    const start = obj.range.offset || 0;
    const len = obj.range.length || total - start;
    headers.set("content-range", `bytes ${start}-${start + len - 1}/${total}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}

async function handleMeta(request, url, env) {
  const token = url.searchParams.get("token") || "";
  const { user, jwt } = await getAuth(request, url, env);
  if (!user) return deny("נדרשת כניסה", 401);
  const access = await checkViewAccess(env, token, user, jwt);
  if (!access.ok) {
    return access.notFound ? deny("השיעור לא נמצא", 404) : deny();
  }
  return json({
    recordingId: access.recording.id,
    title: access.recording.title,
    ownerName: access.recording.owner_name,
    durationS: access.recording.duration_s,
    mime: access.recording.mime,
    createdAt: access.recording.created_at,
    status: access.recording.status,
  });
}

async function handleViewed(request, url, env) {
  const { user, jwt } = await getAuth(request, url, env);
  if (!user) return deny("נדרשת כניסה", 401);
  const { token } = await request.json();
  if (!token) return json({ error: "token חסר" }, 400);
  // הפונקציה בשרת רושמת רק אם הצופה הוא נמען, פעם ביום לכל היותר
  const logged = await rpc(env, "migdalor_log_view", { p_token: token }, jwt);
  return json({ ok: true, logged: !!logged });
}

// ---------- ניתוב ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // צפייה: אימות בתוך ה-handler (הטוקן יכול להגיע בכתובת)
      const view = path.match(/^\/v\/([0-9a-f-]+)$/i);
      if (view && request.method === "GET") {
        return await handleStream(request, url, env, view[1]);
      }
      if (path === "/meta" && request.method === "GET") {
        return await handleMeta(request, url, env);
      }
      if (path === "/viewed" && request.method === "POST") {
        return await handleViewed(request, url, env);
      }

      // העלאה: דורשת משתמש מחובר
      if (path.startsWith("/upload/")) {
        const { user, jwt } = await getAuth(request, url, env);
        if (!user) return deny("נדרשת כניסה", 401);
        if (path === "/upload/create" && request.method === "POST") {
          return await handleUploadCreate(request, env, user, jwt);
        }
        if (path === "/upload/part" && request.method === "PUT") {
          return await handleUploadPart(request, url, env, user);
        }
        if (path === "/upload/complete" && request.method === "POST") {
          return await handleUploadComplete(request, env, user, jwt);
        }
      }

      return new Response("migdalor worker", { status: 200, headers: CORS });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
