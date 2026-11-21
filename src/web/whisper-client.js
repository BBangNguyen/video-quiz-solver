// Chạy Whisper trong Web Worker; tải lỗi (CDN bị chặn) hoặc đứng im quá lâu thì báo lỗi chứ không treo.
import { AUDIO_SAMPLE_RATE, WHISPER } from '../core/constants.js';
import { whisperChunksToSegments } from '../core/speech-to-text.js';

/**
 * @param {Float32Array} pcm - mono 16kHz
 * @param {(text: string) => void} [onStatus]
 * @returns {Promise<{t: number, text: string}[]>}
 */
export function whisperInWorker(pcm, onStatus = () => {}) {
  return new Promise((resolve, reject) => {
    let worker;
    let idleTimer;
    const finish = (settle, value) => {
      clearTimeout(idleTimer);
      worker?.terminate();
      settle(value);
    };
    // Lúc tải: không có tin nhắn nào trong 90s → coi như kẹt. Lúc nghe: worker im lặng tới khi xong,
    // WASM một luồng trên điện thoại có thể chậm hơn thời gian thực → cấp quỹ thời gian theo độ dài audio.
    const audioSec = pcm.length / AUDIO_SAMPLE_RATE;
    const armTimer = (ms, message) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(reject, new Error(message)), ms);
    };
    const armIdleTimer = () => armTimer(WHISPER.idleTimeoutMs, 'Whisper không phản hồi (mạng chậm hoặc CDN bị chặn)');
    try {
      worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      reject(new Error(`Không tạo được Worker cho Whisper: ${e.message}`));
      return;
    }
    // BẮT BUỘC: script worker tải lỗi → bỏ qua audio thay vì chờ mãi.
    worker.onerror = (e) => finish(reject, new Error(`Không tải được Whisper: ${e.message ?? 'lỗi worker'}`));
    worker.onmessageerror = () => finish(reject, new Error('Whisper trả về dữ liệu hỏng'));
    worker.onmessage = ({ data }) => {
      if (data.status === 'transcribing') armTimer(WHISPER.idleTimeoutMs + audioSec * WHISPER.maxRealtimeFactor * 1000, 'Whisper nghe quá lâu trên máy này');
      else armIdleTimer();
      if (data.type === 'progress') {
        onStatus(data.status === 'transcribing' ? 'Whisper đang nghe…' : `Đang tải Whisper${Number.isFinite(data.progress) ? ` ${Math.round(data.progress)}%` : '…'}`);
      } else if (data.type === 'done') {
        finish(resolve, whisperChunksToSegments(data.chunks));
      } else {
        finish(reject, new Error(data.message));
      }
    };
    armIdleTimer();
    const copy = pcm.slice();
    worker.postMessage({ pcm: copy }, [copy.buffer]);
  });
}
