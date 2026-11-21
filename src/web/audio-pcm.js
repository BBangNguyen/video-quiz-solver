// Audio của video → Float32Array mono 16kHz (đầu vào cho speech-to-text).
import { AUDIO_SAMPLE_RATE, MAX_FILE_BYTES_IN_RAM } from '../core/constants.js';

function resampleLinear(buffer, rate) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const out = new Float32Array(Math.floor(buffer.duration * rate));
  const step = buffer.sampleRate / rate;
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    let sum = 0;
    for (const ch of channels) sum += ch[i0] * (1 - frac) + (ch[i0 + 1] ?? ch[i0]) * frac;
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * @param {File} file
 * @returns {Promise<{pcm: Float32Array|null, warning?: string}>} pcm = null khi không có tiếng / không decode được
 */
export async function decodeAudioTo16k(file) {
  if (file.size > MAX_FILE_BYTES_IN_RAM) {
    return { pcm: null, warning: 'Video lớn hơn 150MB: bỏ qua phần nghe để khỏi tràn bộ nhớ. Đề nghe thì nên quay video ngắn hơn.' };
  }
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return { pcm: null, warning: 'Trình duyệt không hỗ trợ đọc audio — chỉ giải theo hình.' };
  const ctx = new AudioCtx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    return { pcm: null }; // video không có tiếng, hoặc codec audio không decode được
  } finally {
    ctx.close().catch(() => {});
  }
  if (!decoded.length) return { pcm: null };
  try {
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * AUDIO_SAMPLE_RATE), AUDIO_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    return { pcm: (await offline.startRendering()).getChannelData(0) };
  } catch {
    return { pcm: resampleLinear(decoded, AUDIO_SAMPLE_RATE) }; // Safari cũ không nhận OfflineAudioContext 16kHz
  }
}
