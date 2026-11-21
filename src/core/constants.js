// Hằng số dùng chung cho web và script eval. Đổi model/prompt/ngưỡng → chạy lại `npm run eval`.

export const MODELS = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5' };

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2026-10-21';

// USD / 1 triệu token, theo bảng model của Anthropic (bản lưu ngày 2026-11-03). Chỉ dùng để ƯỚC TÍNH chi phí.
export const PRICE_PER_MTOK = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

export const FRAME = {
  intervalSec: 1,
  thumbWidth: 160,
  thumbHeight: 90,
  // Đề bài gốc: ngưỡng 40 / 0.3%. Đo trên eval/videos/small-change.mp4 (chữ 22px trên màn 1080p):
  // đổi câu hỏi chỉ làm 0.03–0.11% pixel lệch quá 40 → mất 4/6 câu. Ở ngưỡng 12 là 0.2–0.4%,
  // còn khung đứng yên là 0.00% → hạ xuống 12 / 0.1%. Giữ thừa khung chỉ tốn tiền, sót câu là sai.
  lumaDiff: 12, // một pixel coi là "đổi" khi độ sáng lệch quá ngưỡng này
  minChangedRatio: 0.001, // < 0.1% pixel đổi → khung trùng
  maxEdge: 1920, // model 4.7+ nhận tới 2576px; 1920 = không phóng to video 1080p
  jpegQuality: 0.85,
  seekTimeoutMs: 3000,
  // Docs cho tối đa 600 ảnh/request (128MB). Giữ 80 để request nhẹ trên 4G.
  maxPerRequest: 80,
  maxTotal: 160,
};

export const MAX_FILE_BYTES_IN_RAM = 150 * 1024 * 1024;

export const MODES = {
  accurate: {
    label: '🎯 Chính xác',
    extract: { model: MODELS.opus, effort: 'medium' },
    solve: { model: MODELS.opus, effort: 'high' },
    crossCheck: { model: MODELS.sonnet, effort: 'high' },
    referee: { model: MODELS.opus, effort: 'high' },
  },
  fast: {
    label: '⚡ Nhanh',
    extract: { model: MODELS.sonnet, effort: 'low' },
    solve: { model: MODELS.sonnet, effort: 'medium' },
    crossCheck: null,
    referee: null,
  },
};

export const GEMINI = {
  url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
  model: 'models/gemini-3.5-transcribe',
  chunkSec: 300, // WAV 16kHz mono 5 phút ≈ 12.8MB base64, dưới trần 20MB/request
};

export const WHISPER = {
  cdn: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js',
  model: 'Xenova/whisper-base.en',
  idleTimeoutMs: 90_000, // giai đoạn tải thư viện + model
  maxRealtimeFactor: 10, // giai đoạn nghe: cho phép chậm tới 10× thời lượng audio
};

export const AUDIO_SAMPLE_RATE = 16000;

export const FFMPEG_WASM = {
  coreUrl: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.js',
};
