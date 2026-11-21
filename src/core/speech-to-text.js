// Speech-to-text: Gemini Transcribe (gói free) trước, lỗi/không có key thì Whisper do bên gọi cung cấp.
// Đầu vào: Float32Array mono 16kHz. Đầu ra: transcript có mốc [mm:ss].
import { AUDIO_SAMPLE_RATE, GEMINI } from './constants.js';
import { parseOffset, segmentsToTranscript, wordsToSegments } from './transcript-format.js';

export function encodeWav(pcm, sampleRate = AUDIO_SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Video không có tiếng hoặc gần như im lặng → khỏi gọi STT. */
export function isSilent(pcm) {
  if (!pcm?.length) return true;
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 16) peak = Math.max(peak, Math.abs(pcm[i]));
  return peak < 0.01;
}

/** Response của Interactions API → [{t, text}] theo từ; không có timestamp từ thì trả cả đoạn tại mốc offset. */
export function geminiResponseToSegments(response, offsetSec) {
  const contents = (response.steps ?? []).flatMap((s) => s.content ?? []).filter((c) => c.type === 'text');
  const words = contents
    .flatMap((c) => c.annotations ?? [])
    .filter((a) => a.type === 'word_info')
    .map((a) => ({ t: offsetSec + parseOffset(a.start_offset), text: a.text }));
  if (words.length) return wordsToSegments(words);
  const text = contents.map((c) => c.text).join(' ').trim() || String(response.output_text ?? '').trim();
  return text ? [{ t: offsetSec, text }] : [];
}

async function geminiTranscribeChunk({ pcm, offsetSec, apiKey, fetchFn }) {
  const res = await fetchFn(GEMINI.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: GEMINI.model,
      input: [{ type: 'audio', data: bytesToBase64(encodeWav(pcm)), mime_type: 'audio/wav' }],
      generation_config: { transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } } },
    }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error?.message ?? `Gemini HTTP ${res.status}`);
  return geminiResponseToSegments(body ?? {}, offsetSec);
}

export async function transcribeWithGemini({ pcm, apiKey, fetchFn }) {
  const chunkSamples = GEMINI.chunkSec * AUDIO_SAMPLE_RATE;
  const segments = [];
  for (let start = 0; start < pcm.length; start += chunkSamples) {
    segments.push(
      ...(await geminiTranscribeChunk({
        pcm: pcm.subarray(start, start + chunkSamples),
        offsetSec: start / AUDIO_SAMPLE_RATE,
        apiKey,
        fetchFn,
      })),
    );
  }
  return segments;
}

/** Kết quả chunk của Whisper (transformers.js, return_timestamps) → segments. */
export function whisperChunksToSegments(chunks) {
  return (chunks ?? []).map((c) => ({ t: c.timestamp?.[0] ?? 0, text: c.text }));
}

/**
 * @param {object} p
 * @param {Float32Array|null} p.pcm
 * @param {string} [p.geminiKey]
 * @param {typeof fetch} p.fetchFn
 * @param {(pcm: Float32Array) => Promise<{t: number, text: string}[]>} p.whisper - fallback chạy tại chỗ
 * @returns {Promise<{transcript: string, engine: 'gemini'|'whisper'|'none', warnings: string[]}>}
 */
export async function transcribe({ pcm, geminiKey, fetchFn, whisper }) {
  if (isSilent(pcm)) return { transcript: '', engine: 'none', warnings: [] };
  const warnings = [];
  if (geminiKey) {
    try {
      return { transcript: segmentsToTranscript(await transcribeWithGemini({ pcm, apiKey: geminiKey, fetchFn })), engine: 'gemini', warnings };
    } catch (e) {
      warnings.push(`Gemini Transcribe lỗi (${e.message}) — chuyển sang Whisper.`);
    }
  }
  try {
    return { transcript: segmentsToTranscript(await whisper(pcm)), engine: 'whisper', warnings };
  } catch (e) {
    warnings.push(`Không nghe được audio (${e.message}) — chỉ giải theo hình.`);
    return { transcript: '', engine: 'none', warnings };
  }
}
