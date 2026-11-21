// Tạo video mẫu (chữ + giọng đọc TTS của Windows) vào eval/videos/ và sinh eval/answers.json.
// Chạy: npm run eval:samples   — cũng sinh fixture nhỏ cho Playwright ở tests/e2e/fixtures/.
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';
import { ffmpeg } from './node-media.mjs';
import { SAMPLES } from './sample-definitions.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const videosDir = path.join(here, 'videos');
const fixturesDir = path.join(here, '..', 'tests', 'e2e', 'fixtures');
const work = path.join(os.tmpdir(), 'video-quiz-samples');
const FPS = 10;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const letter = (i) => String.fromCharCode(65 + i);
const questionHtml = (q) =>
  `<div class="q"><p><b>${esc(q.number)}.</b> ${esc(q.text)}</p>${(q.options ?? []).map((o, i) => `<div class="o">${letter(i)}. ${esc(o)}</div>`).join('')}</div>`;
const page = (body, css = '') =>
  `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#fff;color:#111}
  .slide{box-sizing:border-box;padding:56px 72px;font-size:34px;line-height:1.45}
  h1{font-size:30px;color:#1d4ed8;margin:0 0 28px} .q{margin-bottom:34px} .q p{margin:0 0 10px} .o{margin-left:44px}
  ${css}</style>${body}`;
const pairs = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/** Mỗi layout trả về danh sách slide {html, seconds?, speech?}. */
const LAYOUTS = {
  'one-per-slide': (s) =>
    s.questions.map((q) => ({
      html: page(`<div class="slide"><h1>Question ${q.number} of ${s.questions.length}</h1>${questionHtml(q)}</div>`),
      speech: s.speakQuestions ? `Question ${q.number}. ${q.text.replace(/_+/g, 'blank')}` : null,
      seconds: 4,
    })),
  'three-per-slide': (s) =>
    pairs(s.questions, 3).map((group) => ({ html: page(`<div class="slide"><h1>${esc(s.title)}</h1>${group.map(questionHtml).join('')}</div>`), seconds: 5 })),
  pairs: (s) => pairs(s.questions, 2).map((group) => ({ html: page(`<div class="slide"><h1>${esc(s.title)}</h1>${group.map(questionHtml).join('')}</div>`), seconds: 5 })),
  'passage-then-pairs': (s) => [
    { html: page(`<div class="slide"><h1>Read the text and answer the questions.</h1><p>${esc(s.passage)}</p></div>`), seconds: 6 },
    ...pairs(s.questions, 2).map((group) => ({ html: page(`<div class="slide">${group.map(questionHtml).join('')}</div>`), seconds: 5 })),
  ],
  // Giao diện đứng yên, chỉ thẻ câu hỏi (chữ 22px trên nền 1080p) thay đổi.
  'quiz-app': (s) =>
    s.questions.map((q) => ({
      html: page(
        `<div class="bar">VocabMaster — Daily Quiz</div><div class="side">Home<br>Practice<br>Progress<br>Settings</div>
         <div class="hero"></div><div class="card">${questionHtml(q)}</div><div class="foot">Score 120 · Streak 7 days</div>`,
        `.bar{background:#1e293b;color:#fff;padding:22px 40px;font-size:30px}.side{position:absolute;left:0;top:78px;bottom:0;width:260px;background:#f1f5f9;padding:40px;font-size:26px;line-height:2.4}
         .hero{position:absolute;left:320px;top:120px;width:1540px;height:560px;background:linear-gradient(135deg,#38bdf8,#6366f1);border-radius:18px}
         .card{position:absolute;left:320px;top:720px;width:560px;font-size:22px;border:1px solid #cbd5e1;border-radius:12px;padding:18px 24px}.card .q{margin:0}.card .o{margin-left:24px}
         .foot{position:absolute;right:60px;bottom:40px;font-size:24px;color:#475569}`,
      ),
      seconds: 3,
    })),
  scroll: (s) => [{ html: page(`<div class="slide" style="font-size:46px;padding:80px 64px"><h1 style="font-size:52px">${esc(s.title)}</h1>${s.questions.map(questionHtml).join('')}</div>`), scroll: true, seconds: 18 }],
};

async function speak(text, outFile) {
  await run(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = -1; $s.SetOutputToWaveFile($env:TTS_OUT); $s.Speak($env:TTS_TEXT); $s.Dispose()'],
    { env: { ...process.env, TTS_OUT: outFile, TTS_TEXT: text } },
  );
  const header = await readFile(outFile);
  return (header.length - 44) / header.readUInt32LE(28); // số byte audio / byte-rate
}

async function buildSample(sample, browser) {
  const dir = path.join(work, sample.name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const [width, height] = sample.size;
  const tab = await browser.newPage({ viewport: { width, height } });
  const slides = LAYOUTS[sample.layout](sample);
  const out = path.join(videosDir, `${sample.name}.mp4`);
  const encode = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20', '-r', String(FPS), '-movflags', '+faststart'];

  if (slides[0].scroll) {
    await tab.setContent(slides[0].html);
    const png = path.join(dir, 'page.png');
    await tab.screenshot({ path: png, fullPage: true });
    const pageHeight = await tab.evaluate(() => document.documentElement.scrollHeight);
    const speed = Math.max(0, pageHeight - height) / (slides[0].seconds - 3);
    await ffmpeg(['-loop', '1', '-framerate', String(FPS), '-t', String(slides[0].seconds), '-i', png,
      '-vf', `crop=${width}:${height}:0:'min(max(t-1\\,0)*${speed.toFixed(2)}\\,ih-oh)'`, ...encode, '-an', out]);
    await tab.close();
    return;
  }

  // Giọng đọc: mỗi slide một đoạn, hoặc một đoạn dài cho cả video (đề nghe).
  const wholeSpeech = sample.speech ? await speak(sample.speech, path.join(dir, 'speech.wav')) : 0;
  const concat = [];
  const audioParts = [];
  for (const [i, slide] of slides.entries()) {
    const png = path.join(dir, `s${i}.png`);
    await tab.setContent(slide.html);
    await tab.screenshot({ path: png });
    let seconds = wholeSpeech ? Math.ceil(wholeSpeech + 1) / slides.length : slide.seconds;
    if (slide.speech) {
      const raw = path.join(dir, `a${i}.raw.wav`);
      seconds = Math.max(slide.seconds, Math.ceil(await speak(slide.speech, raw) + 1));
      const padded = path.join(dir, `a${i}.wav`);
      await ffmpeg(['-i', raw, '-af', 'apad', '-t', String(seconds), '-ar', '22050', '-ac', '1', padded]);
      audioParts.push(`file '${padded.replace(/\\/g, '/')}'`);
    }
    concat.push(`file '${png.replace(/\\/g, '/')}'`, `duration ${seconds}`);
  }
  concat.push(concat.at(-2)); // concat demuxer cần lặp ảnh cuối để giữ đúng thời lượng
  await tab.close();
  const list = path.join(dir, 'slides.txt');
  await writeFile(list, concat.join('\n'));
  const video = ['-f', 'concat', '-safe', '0', '-i', list];
  if (audioParts.length) {
    const audioList = path.join(dir, 'audio.txt');
    await writeFile(audioList, audioParts.join('\n'));
    await ffmpeg([...video, '-f', 'concat', '-safe', '0', '-i', audioList, ...encode, '-c:a', 'aac', '-b:a', '96k', out]);
  } else if (wholeSpeech) {
    await ffmpeg([...video, '-i', path.join(dir, 'speech.wav'), ...encode, '-c:a', 'aac', '-b:a', '96k', out]);
  } else {
    await ffmpeg([...video, ...encode, '-an', out]);
  }
}

// Fixture nhỏ cho Playwright; bản HEVC để thử nhánh fallback ffmpeg.wasm.
async function buildFixtures() {
  await mkdir(fixturesDir, { recursive: true });
  const src = path.join(videosDir, 'mcq-grammar.mp4');
  const small = ['-t', '9', '-i', src, '-vf', 'scale=640:360', '-r', String(FPS)];
  await ffmpeg([...small, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(fixturesDir, 'quiz.mp4')]);
  await ffmpeg([...small, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', path.join(fixturesDir, 'quiz-silent.mp4')]);
  await ffmpeg([...small, '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(fixturesDir, 'quiz-hevc.mov')]);
}

await mkdir(videosDir, { recursive: true });
const browser = await chromium.launch();
const answers = JSON.parse(await readFile(path.join(here, 'answers.json'), 'utf8').catch(() => '{}'));
for (const sample of SAMPLES) {
  await buildSample(sample, browser);
  answers[`${sample.name}.mp4`] = { note: sample.note, answers: Object.fromEntries(sample.questions.map((q) => [q.number, q.answer])) };
  const { size } = await stat(path.join(videosDir, `${sample.name}.mp4`));
  process.stdout.write(`✅ ${sample.name}.mp4 — ${sample.questions.length} câu, ${(size / 1024).toFixed(0)} KB\n`);
}
await browser.close();
await writeFile(path.join(here, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`);
await buildFixtures();
await rm(work, { recursive: true, force: true });
process.stdout.write('✅ answers.json + fixture Playwright đã sinh xong\n');
