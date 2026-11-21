// Định dạng transcript có mốc thời gian [mm:ss].

export function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// "1.250s" → 1.25
export function parseOffset(offset) {
  const n = parseFloat(String(offset));
  return Number.isFinite(n) ? n : 0;
}

// words: [{t, text}] → segments [{t, text}]; ngắt dòng khi im lặng dài, hết câu, hoặc dòng quá dài.
export function wordsToSegments(words, { maxGapSec = 1.2, maxLineSec = 8 } = {}) {
  const segments = [];
  let current = null;
  let lastT = 0;
  for (const w of words) {
    const text = String(w.text ?? '').trim();
    if (!text) continue;
    const startNew = !current || w.t - lastT > maxGapSec || w.t - current.t > maxLineSec || /[.?!]$/.test(current.text);
    if (startNew) {
      current = { t: w.t, text };
      segments.push(current);
    } else {
      current.text += ` ${text}`;
    }
    lastT = w.t;
  }
  return segments;
}

export function segmentsToTranscript(segments) {
  return segments
    .filter((s) => String(s.text ?? '').trim())
    .map((s) => `[${formatTime(s.t)}] ${String(s.text).trim()}`)
    .join('\n');
}
