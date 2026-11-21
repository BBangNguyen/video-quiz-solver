// Phía Node của khâu media: ffmpeg cắt khung + audio, rồi chạy CÙNG logic lọc khung trùng với bản web.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { AUDIO_SAMPLE_RATE, FRAME, WHISPER } from '../src/core/constants.js';
import { EMPTY_SELECTION, capFrames, flushSelection, selectFrame } from '../src/core/frame-dedupe.js';
import { whisperChunksToSegments } from '../src/core/speech-to-text.js';

const run = promisify(execFile);
export const ffmpeg = (args, options = {}) => run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 30, ...options });

/** Cắt 1 khung/giây, lọc trùng, trả [{t, data: base64 JPEG}] + thống kê. */
export async function extractFrames(videoPath, workDir, maxEdge = FRAME.maxEdge) {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  const thumbSize = FRAME.thumbWidth * FRAME.thumbHeight;
  await ffmpeg([
    '-i', videoPath,
    '-filter_complex',
    `[0:v]fps=${1 / FRAME.intervalSec},split[a][b];` +
      `[a]scale=w='min(${maxEdge},iw)':h='min(${maxEdge},ih)':force_original_aspect_ratio=decrease[full];` +
      `[b]scale=${FRAME.thumbWidth}:${FRAME.thumbHeight},format=gray[thumb]`,
    '-map', '[full]', '-q:v', '3', path.join(workDir, 'f_%05d.jpg'),
    '-map', '[thumb]', '-f', 'rawvideo', path.join(workDir, 'thumbs.gray'),
  ]);
  const thumbs = await readFile(path.join(workDir, 'thumbs.gray'));
  const files = (await readdir(workDir)).filter((f) => f.endsWith('.jpg')).sort();
  let state = EMPTY_SELECTION;
  const kept = [];
  files.forEach((file, i) => {
    const thumb = thumbs.subarray(i * thumbSize, (i + 1) * thumbSize);
    if (thumb.length < thumbSize) return;
    const step = selectFrame(state, { t: i * FRAME.intervalSec, thumb, file });
    state = step.state;
    kept.push(...step.keep);
  });
  const selected = capFrames([...kept, ...flushSelection(state)], FRAME.maxTotal);
  const frames = await Promise.all(
    selected.map(async (f) => ({ t: f.t, data: (await readFile(path.join(workDir, f.file))).toString('base64') })),
  );
  return { frames, sampled: files.length };
}

/** Audio → Float32Array mono 16kHz; null nếu video không có tiếng. */
export async function extractPcm(videoPath) {
  try {
    const { stdout } = await ffmpeg(['-i', videoPath, '-vn', '-ac', '1', '-ar', String(AUDIO_SAMPLE_RATE), '-f', 'f32le', '-'], { encoding: 'buffer' });
    return stdout.length ? new Float32Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 4)).slice() : null;
  } catch (e) {
    if (/does not contain any stream|matches no streams/i.test(String(e.stderr ?? e.message))) return null;
    throw e;
  }
}

let whisperPipeline;
/** Whisper fallback phía Node: cùng thư viện + model với Web Worker của bản web. */
export async function whisperNode(pcm) {
  const { pipeline } = await import('@huggingface/transformers');
  whisperPipeline ??= await pipeline('automatic-speech-recognition', WHISPER.model);
  const out = await whisperPipeline(pcm, { return_timestamps: true, chunk_length_s: 30 });
  return whisperChunksToSegments(out.chunks);
}
