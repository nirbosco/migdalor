// מתקן משך ל-webm של MediaRecorder.
// הקלטת דפדפן שומרת webm בלי שדה Duration בכותרת, ובלי זה נגן לא יכול
// להזרים ולדלג בציר הזמן על קובץ מרוחק. מזריק Duration ל-Segment>Info.
//
// חשוב לזיכרון: לא טוענים את כל הסרטון לזיכרון. קוראים רק את תחילת הקובץ
// (עד 1MB, מספיק ל-EBML header + Info), מתקנים את הכותרת, ומחברים את שאר
// הסרטון כהפניית Blob (blob.slice) בלי להעתיק אותו ל-JS. בטוח לכל גודל.
(function (global) {
  var HEAD_BYTES = 1024 * 1024;

  function readId(b, p) {
    var first = b[p], len = 1, mask = 0x80;
    while (len <= 4 && !(first & mask)) { len++; mask >>= 1; }
    var id = 0; for (var i = 0; i < len; i++) id = id * 256 + b[p + i];
    return { id: id, length: len };
  }
  function readVint(b, p) {
    var first = b[p], len = 1, mask = 0x80;
    while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
    var value = first & (mask - 1);
    for (var i = 1; i < len; i++) value = value * 256 + b[p + i];
    return { value: value, length: len };
  }
  function isUnknownSize(b, sizeOff, sizeLen) {
    var first = b[sizeOff];
    var mask = (1 << (8 - sizeLen)) - 1;
    if ((first & mask) !== mask) return false;
    for (var i = 1; i < sizeLen; i++) if (b[sizeOff + i] !== 0xff) return false;
    return true;
  }
  function encodeVint(v) {
    var len = 1;
    while (v >= Math.pow(2, 7 * len) - 1 && len < 8) len++;
    var bytes = new Array(len);
    var n = v + Math.pow(2, 7 * len);
    for (var i = len - 1; i >= 0; i--) { bytes[i] = n & 0xff; n = Math.floor(n / 256); }
    return bytes;
  }
  function durationElement(ms) {
    var f = Array.prototype.slice.call(new Uint8Array(new Float64Array([ms]).buffer)).reverse();
    return [0x44, 0x89].concat(encodeVint(f.length)).concat(f); // Duration id 0x4489
  }

  // מקבל את בייטי הכותרת (Uint8Array של תחילת הקובץ) ומחזיר
  // { contentStart, patchedHead } או null אם לא ניתן לתקן בתוך החלק שנקרא.
  function computePatch(b, durationMs) {
    var p = 0;
    var idr = readId(b, p);
    if (idr.id === 0x1A45DFA3) { // EBML header
      p += idr.length; var hs = readVint(b, p); p += hs.length + hs.value;
    }
    if (p + 4 >= b.length) return null;
    idr = readId(b, p);
    if (idr.id !== 0x18538067) return null; // Segment
    p += idr.length;
    var segSizeOff = p, segSize = readVint(b, segSizeOff);
    var segUnknown = isUnknownSize(b, segSizeOff, segSize.length);
    p += segSize.length;
    var end = segUnknown ? b.length : Math.min(p + segSize.value, b.length);

    while (p + 2 < end && p + 2 < b.length) {
      var eid = readId(b, p);
      var szOff = p + eid.length;
      if (szOff >= b.length) return null;
      var esize = readVint(b, szOff);
      var unk = isUnknownSize(b, szOff, esize.length);
      var contentStart = szOff + esize.length;

      if (eid.id === 0x1549A966 && !unk) { // Info
        // ודא שאין כבר Duration בתוך Info (רק בחלק שנקרא)
        var infoEnd = Math.min(contentStart + esize.value, b.length), q = contentStart, has = false;
        while (q < infoEnd) {
          var sid = readId(b, q); q += sid.length;
          if (q >= b.length) break;
          var ssz = readVint(b, q); q += ssz.length;
          if (sid.id === 0x4489) { has = true; break; }
          q += ssz.value;
        }
        if (has) return null; // כבר תקין

        var durEl = durationElement(durationMs);
        var newSizeBytes = encodeVint(esize.value + durEl.length);
        // patchedHead = b[0..szOff) + newSizeBytes + durEl. השאר מגיע מ-blob.slice(contentStart)
        var patched = new Uint8Array(szOff + newSizeBytes.length + durEl.length);
        patched.set(b.subarray(0, szOff), 0);
        patched.set(newSizeBytes, szOff);
        patched.set(durEl, szOff + newSizeBytes.length);
        // תיקון גודל ה-Segment אם אינו unknown-size ואורך הקידוד לא משתנה
        if (!segUnknown) {
          var delta = durEl.length + (newSizeBytes.length - esize.length);
          var newSeg = encodeVint(segSize.value + delta);
          if (newSeg.length === segSize.length) {
            for (var k = 0; k < newSeg.length; k++) patched[segSizeOff + k] = newSeg[k];
          }
        }
        return { contentStart: contentStart, patchedHead: patched };
      }
      if (unk) return null; // אלמנט unknown-size לפני Info: לא ניתן לדעת אורך בבטחה
      p = contentStart + esize.value;
    }
    return null; // Info לא נמצא בחלק שנקרא
  }

  global.fixWebmDuration = function (blob, durationMs) {
    var headLen = Math.min(HEAD_BYTES, blob.size);
    return blob.slice(0, headLen).arrayBuffer().then(function (buf) {
      var r;
      try { r = computePatch(new Uint8Array(buf), durationMs); }
      catch (e) { r = null; }
      if (!r) return blob; // לא ניתן לתקן: מחזירים כמו שהוא (עדיין ניתן לניגון)
      // הכותרת המתוקנת + שאר הסרטון כהפניית Blob (בלי העתקה לזיכרון)
      return new Blob(
        [r.patchedHead, blob.slice(r.contentStart)],
        { type: blob.type || "video/webm" }
      );
    });
  };
})(typeof window !== "undefined" ? window : this);
