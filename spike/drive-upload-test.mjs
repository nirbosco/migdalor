#!/usr/bin/env node
// ספייק המגדלור, חלק ב, צעד 1: העלאה resumable של קובץ וידאו ל-Shared Drive.
// שימוש:
//   node drive-upload-test.mjs <service-account.json> <shared-drive-or-folder-id> <video-file>
// דרישות: Node 18 ומעלה. בלי תלויות חיצוניות (REST ישיר + JWT ב-crypto מובנה).
// מה נבדק: פתיחת סשן resumable, העלאה במקטעים של 8MB עם הדפסת התקדמות,
// והתאוששות: אם מפילים את הסקריפט באמצע ומריצים שוב עם אותם פרמטרים,
// הוא ממשיך מאותו סשן (נשמר בקובץ .upload-session ליד הווידאו).

import { createSign } from "node:crypto";
import { readFile, writeFile, unlink, stat, open } from "node:fs/promises";

const [keyPath, driveId, videoPath] = process.argv.slice(2);
if (!videoPath) {
  console.error("שימוש: node drive-upload-test.mjs <service-account.json> <drive-folder-id> <video-file>");
  process.exit(1);
}

const CHUNK = 8 * 256 * 1024 * 4; // 8MB, כפולה של 256KB כנדרש
const sessionFile = videoPath + ".upload-session";

async function accessToken() {
  const key = JSON.parse(await readFile(keyPath, "utf8"));
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = b64({ alg: "RS256", typ: "JWT" }) + "." + b64({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600
  });
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("token failed: " + JSON.stringify(j));
  return j.access_token;
}

async function openSession(token, size) {
  try {
    const saved = JSON.parse(await readFile(sessionFile, "utf8"));
    if (saved.size === size) {
      console.log("נמצא סשן קודם, מנסים להמשיך ממנו...");
      return saved.url;
    }
  } catch {}
  const name = videoPath.split("/").pop();
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ name: `spike-${Date.now()}-${name}`, parents: [driveId] })
    }
  );
  if (!res.ok) throw new Error("session failed: " + res.status + " " + await res.text());
  const url = res.headers.get("location");
  await writeFile(sessionFile, JSON.stringify({ url, size }));
  return url;
}

async function askOffset(url, size) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-range": `bytes */${size}` }
  });
  if (res.status === 308) {
    const r = res.headers.get("range");
    return r ? parseInt(r.split("-")[1]) + 1 : 0;
  }
  if (res.ok) return size; // כבר הושלם
  return 0;
}

const size = (await stat(videoPath)).size;
const token = await accessToken();
const url = await openSession(token, size);
let offset = await askOffset(url, size);
console.log(`גודל הקובץ: ${(size / 1048576).toFixed(1)}MB, מתחילים מ-${(offset / 1048576).toFixed(1)}MB`);

const fh = await open(videoPath);
const t0 = Date.now();
while (offset < size) {
  const len = Math.min(CHUNK, size - offset);
  const buf = Buffer.alloc(len);
  await fh.read(buf, 0, len, offset);
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "content-length": String(len),
      "content-range": `bytes ${offset}-${offset + len - 1}/${size}`
    },
    body: buf
  });
  if (res.status === 308) {
    offset += len;
    const mbps = (offset / 131072 / ((Date.now() - t0) / 1000)).toFixed(1);
    process.stdout.write(`\r${((offset / size) * 100).toFixed(1)}%  (${mbps} Mbps)   `);
  } else if (res.ok) {
    const file = await res.json();
    console.log(`\nהועלה בהצלחה. fileId: ${file.id}`);
    console.log("את ה-fileId הזה מדביקים בנגן הבדיקה (player.html) מול ה-Worker.");
    await unlink(sessionFile).catch(() => {});
    process.exit(0);
  } else {
    console.error(`\nשגיאה ${res.status}: ${await res.text()}`);
    console.error("אפשר להריץ שוב את אותה פקודה, ההעלאה תמשיך מאותה נקודה.");
    process.exit(1);
  }
}
