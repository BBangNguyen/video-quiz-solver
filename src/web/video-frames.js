// Cắt khung hình ngay trên trình duyệt: <video> ẩn → canvas → JPEG, lọc trùng bằng logic ở core.
// Video trình duyệt không decode được (HEVC .mov trên Android) → thử ffmpeg.wasm → không được nữa thì báo cách sửa.
import { FFMPEG_WASM, FRAME, MAX_FILE_BYTES_IN_RAM } from '../core/constants.js';
import { EMPTY_SELECTION, capFrames, flushSelection, rgbaToLuma, selectFrame } from '../core/frame-dedupe.js';

export const HEVC_HELP =
  "Trình duyệt này không đọc được video (thường là video HEVC .mov từ iPhone). Trên iPhone vào Cài đặt → Camera → Định dạng → chọn 'Tương thích nhất', rồi quay lại video.";

class VideoDecodeError extends Error {}

const waitEvent = (target, events, timeoutMs) =>
  new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      events.forEach((name) => target.removeEventListener(name, onEvent));
      resolve(ok);
    };
    const onEvent = (e) => done(e.type !== 'error');
    const timer = setTimeout(() => done(false), timeoutMs);
    events.forEach((name) => target.addEventListener(name, onEvent));
  });

// Safari đôi khi chưa kịp vẽ khung mới ngay lúc `seeked`; rAF không chạy khi tab ẩn nên kèm timer.
const nextPaint = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, 60);
  requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve();
  });
});

async function seekTo(video, t) {
  if (Math.abs(video.currentTime - t) < 0.01 && video.readyState >= 2) return true;
  const seeked = waitEvent(video, ['seeked', 'error'], FRAME.seekTimeoutMs);
  video.currentTime = t;
  return seeked;
}

/** Nguồn khung từ thẻ <video>: yield {t, image, width, height, progress}. */
async function* videoElementFrames(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(video);
  const url = URL.createObjectURL(file);
  try {
    const loaded = waitEvent(video, ['loadeddata', 'error'], 20_000);
    video.src = url;
    video.load();
    if (!(await loaded) || !video.videoWidth) throw new VideoDecodeError('Không đọc được hình của video');
    // iOS chỉ chịu vẽ khung lên canvas sau khi video đã từng phát.
    await video.play().then(() => video.pause(), () => {});
    if (!Number.isFinite(video.duration)) {
      await seekTo(video, 1e7); // WebM thiếu duration: tua thật xa để trình duyệt tự tính
      if (!Number.isFinite(video.duration)) throw new VideoDecodeError('Không xác định được độ dài video');
    }
    const duration = video.duration;
    let misses = 0;
    let yielded = 0;
    for (let t = 0; t < duration; t += FRAME.intervalSec) {
      if (!(await seekTo(video, Math.min(t, Math.max(0, duration - 0.05))))) {
        // Mỗi lần seek có timeout 3s: bỏ khung đó đi tiếp; hỏng liên tục từ đầu thì coi như không decode được.
        if (++misses >= 3 && yielded === 0) throw new VideoDecodeError('Tua video không được');
        continue;
      }
      await nextPaint();
      yielded++;
      yield { t, image: video, width: video.videoWidth, height: video.videoHeight, progress: Math.min(1, (t + 1) / duration) };
    }
    if (!yielded) throw new VideoDecodeError('Không lấy được khung hình nào');
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

const FFMPEG_SEGMENT_SEC = 20;
const FFMPEG_LOAD_TIMEOUT_MS = 180_000;
const FFMPEG_IDLE_TIMEOUT_MS = 60_000;

/**
 * Nguồn khung dự phòng: ffmpeg.wasm (một luồng — GitHub Pages không bật được COOP/COEP) giải mã rồi xuất 1 khung/giây.
 * - Xuất PNG: bộ mã hoá JPEG của lõi wasm sập ("memory access out of bounds") với khung từ 720p trở lên.
 * - Chạy theo từng đoạn 20s và xoá file ngay sau khi đọc để bộ nhớ wasm không phình theo độ dài video.
 * - Lõi wasm sập thì `exec` không bao giờ trả về → canh bằng đồng hồ im lặng (log của ffmpeg là nhịp tim).
 */
async function* ffmpegFrames(file, onNotice) {
  if (file.size > MAX_FILE_BYTES_IN_RAM) throw new Error('Video quá lớn để giải mã bằng ffmpeg trong trình duyệt');
  const { FFmpeg } = await import('../../vendor/ffmpeg/index.js');
  const ff = new FFmpeg();
  let duration = null;
  let watchdog = null;
  let abort = () => {};
  const arm = (ms) => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => abort(new Error('ffmpeg không phản hồi')), ms);
  };
  const guarded = (promise, ms) =>
    new Promise((resolve, reject) => {
      abort = reject;
      arm(ms);
      promise.then(resolve, reject);
    }).finally(() => clearTimeout(watchdog));
  ff.on('log', ({ message }) => {
    arm(FFMPEG_IDLE_TIMEOUT_MS);
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(message);
    if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  });
  const perSegment = FFMPEG_SEGMENT_SEC / FRAME.intervalSec;
  const filter = `fps=${1 / FRAME.intervalSec},scale=w='min(${FRAME.maxEdge},iw)':h='min(${FRAME.maxEdge},ih)':force_original_aspect_ratio=decrease`;
  let yielded = 0;
  try {
    onNotice('Đang tải bộ giải mã ffmpeg (~32MB, chỉ lần đầu)…');
    await guarded(ff.load({ coreURL: FFMPEG_WASM.coreUrl }), FFMPEG_LOAD_TIMEOUT_MS);
    await ff.writeFile('input', new Uint8Array(await file.arrayBuffer()));
    for (let start = 0; start < 3600; start += FFMPEG_SEGMENT_SEC) {
      onNotice(`Đang giải mã video bằng ffmpeg${duration ? ` ${Math.min(100, Math.round((100 * start) / duration))}%` : '…'}`);
      await guarded(ff.exec(['-ss', String(start), '-t', String(FFMPEG_SEGMENT_SEC), '-i', 'input', '-vf', filter, 'f_%05d.png']), FFMPEG_IDLE_TIMEOUT_MS);
      const names = (await ff.listDir('/')).map((n) => n.name).filter((n) => /^f_\d+\.png$/.test(n)).sort();
      for (const [i, name] of names.entries()) {
        const data = await ff.readFile(name);
        await ff.deleteFile(name);
        if (i >= perSegment) continue; // khung dư ở mép đoạn trùng với khung đầu đoạn sau
        const image = await createImageBitmap(new Blob([data], { type: 'image/png' }));
        const t = start + i * FRAME.intervalSec;
        yielded++;
        yield { t, image, width: image.width, height: image.height, progress: duration ? Math.min(1, (t + 1) / duration) : 0 };
        image.close();
      }
      if (names.length < perSegment) break; // đoạn cuối
    }
    if (!yielded) throw new Error('ffmpeg không giải mã được video');
  } finally {
    clearTimeout(watchdog);
    ff.terminate();
  }
}

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: width === FRAME.thumbWidth });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas, ctx };
}

/** Chạy lọc trùng trên một nguồn khung, chỉ mã hoá JPEG các khung được giữ. */
async function collectFrames(source, onProgress) {
  const thumb = makeCanvas(FRAME.thumbWidth, FRAME.thumbHeight);
  // Hai canvas luân phiên: khung "chờ" (có thể là khung cuối trước khi màn hình đổi) không bị khung sau vẽ đè.
  let buffers = null;
  let active = 0;
  let state = EMPTY_SELECTION;
  const frames = [];
  const encode = (f) => ({ t: f.t, data: f.canvas.toDataURL('image/jpeg', FRAME.jpegQuality).split(',')[1] });

  for await (const frame of source) {
    if (!buffers) {
      const scale = Math.min(1, FRAME.maxEdge / Math.max(frame.width, frame.height));
      buffers = [0, 1].map(() => makeCanvas(Math.round(frame.width * scale), Math.round(frame.height * scale)));
    }
    thumb.ctx.drawImage(frame.image, 0, 0, FRAME.thumbWidth, FRAME.thumbHeight);
    const luma = rgbaToLuma(thumb.ctx.getImageData(0, 0, FRAME.thumbWidth, FRAME.thumbHeight).data);
    const { canvas, ctx } = buffers[active];
    ctx.drawImage(frame.image, 0, 0, canvas.width, canvas.height);
    const step = selectFrame(state, { t: frame.t, thumb: luma, canvas });
    state = step.state;
    frames.push(...step.keep.map(encode));
    if (state.pending?.canvas === canvas) active = 1 - active;
    onProgress(frame.progress);
  }
  frames.push(...flushSelection(state).map(encode));
  return capFrames(frames, FRAME.maxTotal);
}

/**
 * @param {File} file
 * @param {{onProgress?: (ratio: number) => void, onNotice?: (text: string) => void}} [hooks]
 * @returns {Promise<{t: number, data: string}[]>} khung JPEG base64 đã lọc trùng
 */
export async function extractFrames(file, { onProgress = () => {}, onNotice = () => {} } = {}) {
  try {
    return await collectFrames(videoElementFrames(file), onProgress);
  } catch (e) {
    if (!(e instanceof VideoDecodeError)) throw e;
  }
  try {
    onProgress(0);
    return await collectFrames(ffmpegFrames(file, onNotice), onProgress);
  } catch (cause) {
    throw new Error(`${HEVC_HELP}\n(Chi tiết kỹ thuật: ${cause?.message ?? cause})`, { cause });
  }
}
