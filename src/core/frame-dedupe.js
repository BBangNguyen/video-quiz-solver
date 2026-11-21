// Lọc khung trùng theo TỈ LỆ PIXEL THAY ĐỔI trên bản thu nhỏ xám 160x90.
// Không dùng trung bình toàn ảnh: câu hỏi mới chỉ đổi một vùng chữ nhỏ sẽ bị trung bình nuốt mất.
import { FRAME } from './constants.js';

export function rgbaToLuma(rgba) {
  const luma = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < luma.length; i++) {
    const p = i * 4;
    luma[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return luma;
}

export function changedRatio(a, b, lumaDiff = FRAME.lumaDiff) {
  if (a.length !== b.length) throw new Error(`Thumbnail lệch kích thước: ${a.length} ≠ ${b.length}`);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > lumaDiff) changed++;
  return changed / a.length;
}

export const EMPTY_SELECTION = Object.freeze({ ref: null, pending: null });

// Reducer thuần: nhận khung {t, thumb, ...} theo thứ tự thời gian.
// - ref: thumb của khung vừa giữ gần nhất.
// - pending: khung trùng mới nhất chưa giữ. Khi màn hình đổi, nó chính là "khung cuối trước khi đổi"
//   (thường là lúc câu hỏi hiện đầy đủ nhất) nên được giữ thêm.
export function selectFrame(state, frame, minChangedRatio = FRAME.minChangedRatio) {
  if (!state.ref) return { state: { ref: frame.thumb, pending: null }, keep: [frame] };
  if (changedRatio(state.ref, frame.thumb) < minChangedRatio) {
    return { state: { ref: state.ref, pending: frame }, keep: [] };
  }
  const keep = state.pending ? [state.pending, frame] : [frame];
  return { state: { ref: frame.thumb, pending: null }, keep };
}

// Hết video: khung cuối cùng cũng là "khung cuối trước khi đổi".
export function flushSelection(state) {
  return state.pending ? [state.pending] : [];
}

// Lấy mẫu đều khi vượt giới hạn số ảnh, luôn giữ khung đầu và khung cuối.
export function capFrames(frames, max) {
  if (frames.length <= max) return frames;
  if (max <= 1) return frames.slice(0, max);
  return Array.from({ length: max }, (_, i) => frames[Math.round((i * (frames.length - 1)) / (max - 1))]);
}
