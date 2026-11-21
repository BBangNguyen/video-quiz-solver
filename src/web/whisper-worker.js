// Web Worker: Whisper chạy ngay trong trình duyệt (fallback khi không có key Gemini hoặc Gemini lỗi).
// Thư viện + model tải từ CDN ở lần đầu; mọi lỗi đều được báo về luồng chính để app không treo.
import { WHISPER } from '../core/constants.js';

let transcriber;

self.onmessage = async ({ data }) => {
  try {
    if (!transcriber) {
      const { pipeline } = await import(WHISPER.cdn).catch(() => {
        throw new Error('không tải được thư viện Whisper từ CDN');
      });
      transcriber = await pipeline('automatic-speech-recognition', WHISPER.model, {
        progress_callback: (p) => self.postMessage({ type: 'progress', status: p.status, progress: p.progress }),
      });
    }
    self.postMessage({ type: 'progress', status: 'transcribing' });
    const out = await transcriber(data.pcm, { return_timestamps: true, chunk_length_s: 30 });
    self.postMessage({ type: 'done', chunks: out.chunks ?? [{ timestamp: [0, null], text: out.text ?? '' }] });
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e?.message ?? e) });
  }
};
