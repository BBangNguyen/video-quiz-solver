import test from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_SELECTION, capFrames, changedRatio, flushSelection, rgbaToLuma, selectFrame } from '../../src/core/frame-dedupe.js';

const SIZE = 160 * 90;
const blank = (value = 255) => new Uint8Array(SIZE).fill(value);
// Vẽ "chữ" tối lên một vùng nhỏ: `count` pixel bắt đầu từ `start`.
const withText = (base, start, count) => {
  const thumb = Uint8Array.from(base);
  thumb.fill(20, start, start + count);
  return thumb;
};
const runSelection = (thumbs) => {
  let state = EMPTY_SELECTION;
  const kept = [];
  thumbs.forEach((thumb, t) => {
    const step = selectFrame(state, { t, thumb });
    state = step.state;
    kept.push(...step.keep);
  });
  return [...kept, ...flushSelection(state)].map((f) => f.t);
};

test('changedRatio đếm tỉ lệ pixel lệch quá ngưỡng độ sáng', () => {
  assert.equal(changedRatio(blank(), blank()), 0);
  assert.equal(changedRatio(blank(), withText(blank(), 0, SIZE / 100)), 0.01);
  assert.equal(changedRatio(blank(200), blank(190)), 0, 'lệch 10 < ngưỡng 12 → không tính');
  assert.equal(changedRatio(blank(200), blank(170)), 1);
  assert.throws(() => changedRatio(blank(), new Uint8Array(10)), /lệch kích thước/);
});

test('câu hỏi mới chỉ đổi vùng chữ nhỏ (0.5% pixel) vẫn được giữ — trung bình toàn ảnh sẽ bỏ sót', () => {
  const q1 = withText(blank(), 1000, 72);
  const q2 = withText(blank(), 5000, 72); // chữ khác vị trí: 144 pixel đổi = 1%
  const meanDiff = Math.abs(q1.reduce((a, b) => a + b, 0) - q2.reduce((a, b) => a + b, 0)) / SIZE;
  assert.equal(meanDiff, 0, 'độ sáng trung bình y hệt nhau → cách trung bình coi là khung trùng');
  assert.deepEqual(runSelection([q1, q2]), [0, 1]);
});

test('khung trùng (< 0.1% pixel đổi) bị bỏ', () => {
  const base = blank();
  const noisy = withText(base, 0, 14); // 14/14400 = 0.097%
  assert.deepEqual(runSelection([base, noisy, base]), [0, 2], 'chỉ giữ khung đầu và khung cuối video');
});

test('khi màn hình đổi, giữ thêm khung cuối cùng trước khi đổi', () => {
  const a = blank();
  const aMore = withText(a, 0, 10); // vẫn "trùng" với a nhưng đầy đủ hơn
  const b = withText(blank(), 3000, 800);
  assert.deepEqual(runSelection([a, a, aMore, b, b, b]), [0, 2, 3, 5]);
});

test('không có khung trùng ở giữa thì không giữ thừa', () => {
  const frames = [0, 1, 2].map((i) => withText(blank(), i * 2000, 500));
  assert.deepEqual(runSelection(frames), [0, 1, 2]);
});

test('capFrames lấy mẫu đều, giữ khung đầu và cuối', () => {
  const frames = Array.from({ length: 10 }, (_, t) => ({ t }));
  assert.equal(capFrames(frames, 20), frames);
  assert.deepEqual(capFrames(frames, 4).map((f) => f.t), [0, 3, 6, 9]);
});

test('rgbaToLuma đổi RGBA sang độ sáng', () => {
  assert.deepEqual([...rgbaToLuma(Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]))], [255, 0, 76]);
});
