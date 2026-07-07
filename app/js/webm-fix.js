// מתקן משך ל-webm של MediaRecorder.
// הקלטת דפדפן שומרת webm בלי שדה Duration בכותרת, ובלי זה נגן לא יכול
// להזרים ולדלג בציר הזמן על קובץ מרוחק. הפונקציה מזריקה Duration ל-Segment>Info.
// מימוש עצמאי, בלי תלויות. משך ביחידות של TimecodeScale (ברירת מחדל 1e6 ⇒ מילישניות).
(function (global) {
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

  function injectDuration(b, durationMs) {
    var p = 0;
    var idr = readId(b, p);
    if (idr.id === 0x1A45DFA3) { // דלג על EBML header
      p += idr.length; var hs = readVint(b, p); p += hs.length + hs.value;
    }
    idr = readId(b, p);
    if (idr.id !== 0x18538067) return b; // Segment לא נמצא
    p += idr.length;
    var segSizeOff = p, segSize = readVint(b, p);
    var segUnknown = isUnknownSize(b, segSizeOff, segSize.length);
    p += segSize.length;
    var end = segUnknown ? b.length : Math.min(p + segSize.value, b.length);

    while (p + 2 < end) {
      var eid = readId(b, p); var eidLen = eid.length;
      var szOff = p + eidLen;
      var esize = readVint(b, szOff);
      var unk = isUnknownSize(b, szOff, esize.length);
      var contentStart = szOff + esize.length;

      if (eid.id === 0x1549A966 && !unk) { // Info
        var infoEnd = contentStart + esize.value, q = contentStart;
        while (q < infoEnd) {
          var sid = readId(b, q); q += sid.length;
          var ssz = readVint(b, q); q += ssz.length;
          if (sid.id === 0x4489) return b; // כבר יש Duration
          q += ssz.value;
        }
        var durEl = durationElement(durationMs);
        var newLen = esize.value + durEl.length;
        var newSizeBytes = encodeVint(newLen);
        var out = [];
        for (var i = 0; i < szOff; i++) out.push(b[i]);        // הכל עד בייטי הגודל של Info
        for (var s = 0; s < newSizeBytes.length; s++) out.push(newSizeBytes[s]); // גודל Info חדש
        for (var d = 0; d < durEl.length; d++) out.push(durEl[d]);               // Duration
        for (var r = contentStart; r < b.length; r++) out.push(b[r]);            // שאר הקובץ
        var res = new Uint8Array(out);
        if (!segUnknown) {
          var delta = durEl.length + (newSizeBytes.length - esize.length);
          var newSeg = encodeVint(segSize.value + delta);
          if (newSeg.length === segSize.length) {
            var shift = newSizeBytes.length - esize.length;
            for (var k = 0; k < newSeg.length; k++) res[segSizeOff + k] = newSeg[k];
          }
        }
        return res;
      }
      if (unk) break;
      p = contentStart + esize.value;
    }
    return b;
  }

  global.fixWebmDuration = function (blob, durationMs) {
    return blob.arrayBuffer().then(function (buf) {
      var patched = injectDuration(new Uint8Array(buf), durationMs);
      return new Blob([patched], { type: blob.type || "video/webm" });
    });
  };
})(typeof window !== "undefined" ? window : this);
