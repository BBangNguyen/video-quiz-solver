// Chạy CÙNG pipeline với bản web trên mọi video trong eval/videos/ rồi chấm theo eval/answers.json.
//   npm run eval                     → cả hai chế độ, ghi eval/RESULTS.md
//   npm run eval -- --mode fast      → một chế độ
//   npm run eval -- --only scroll    → một video
//   npm run eval -- --dry            → chỉ cắt khung + STT, không gọi Claude (không tốn tiền)
//   npm run eval -- --edge 1568      → đổi cạnh dài ảnh để so sánh
// Key đọc từ .env: ANTHROPIC_API_KEY (bắt buộc trừ --dry), GEMINI_API_KEY (không bắt buộc).
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME, GEMINI, MODES, WHISPER } from '../src/core/constants.js';
import { callClaude } from '../src/core/claude-client.js';
import { formatUsd } from '../src/core/cost.js';
import { formatAnswerLine, normalizeAnswer } from '../src/core/cross-check.js';
import { runPipeline } from '../src/core/pipeline.js';
import { transcribe } from '../src/core/speech-to-text.js';
import { extractFrames, extractPcm, whisperNode } from './node-media.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const modes = option('mode', 'both') === 'both' ? ['accurate', 'fast'] : [option('mode')];
const maxEdge = Number(option('edge', FRAME.maxEdge));
const only = option('only', null);
const dry = flag('dry');
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!dry && !apiKey) {
  process.stderr.write('❌ Thiếu ANTHROPIC_API_KEY trong .env (hoặc chạy với --dry để chỉ thử khâu media).\n');
  process.exit(1);
}

const log = (line) => process.stdout.write(`${line}\n`);
const key = (number) => String(number).toLowerCase().replace(/[^a-z0-9]/g, '');
const pct = (n, total) => (total ? `${((100 * n) / total).toFixed(1)}%` : '—');

/** Chấm một video: đúng / sót / (?) so với đáp án chuẩn. */
export function grade(gold, output) {
  const byKey = new Map(output.results.map((r) => [key(r.number), r]));
  const questions = new Map(output.questions.map((q) => [key(q.number), q]));
  const rows = Object.entries(gold).map(([number, expected]) => {
    const got = byKey.get(key(number));
    const q = questions.get(key(number));
    const accepted = [expected].flat().map((e) => normalizeAnswer(e, q));
    const missed = !got || !String(got.answer).trim();
    return { number, expected: [expected].flat().join(' | '), got: got ? formatAnswerLine(got) : '(sót)', missed, correct: !missed && accepted.includes(normalizeAnswer(got.answer, q)), flagged: Boolean(got?.uncertain) };
  });
  return { rows, total: rows.length, correct: rows.filter((r) => r.correct).length, missed: rows.filter((r) => r.missed).length, flagged: rows.filter((r) => r.flagged).length, extra: Math.max(0, output.results.length - rows.length) };
}

const allGold = JSON.parse(await readFile(path.join(here, 'answers.json'), 'utf8'));
const videos = (await readdir(path.join(here, 'videos'))).filter((f) => /\.(mp4|mov|webm|m4v)$/i.test(f) && (!only || f.startsWith(only))).sort();
const runs = [];

for (const file of videos) {
  const gold = allGold[file]?.answers;
  if (!gold) {
    log(`⚠️ ${file}: chưa có đáp án trong answers.json → bỏ qua`);
    continue;
  }
  const videoPath = path.join(here, 'videos', file);
  const mediaStart = performance.now();
  const [{ frames, sampled }, pcm] = await Promise.all([
    extractFrames(videoPath, path.join(os.tmpdir(), 'video-quiz-eval', file), maxEdge),
    extractPcm(videoPath),
  ]);
  const stt = await transcribe({ pcm, geminiKey: process.env.GEMINI_API_KEY, fetchFn: fetch, whisper: whisperNode });
  const mediaSec = (performance.now() - mediaStart) / 1000;
  log(`\n🎬 ${file}: giữ ${frames.length}/${sampled} khung · STT: ${stt.engine}${stt.warnings.length ? ` · ${stt.warnings.join(' ')}` : ''} · ${mediaSec.toFixed(1)}s`);
  if (stt.transcript) log(stt.transcript.split('\n').map((l) => `   ${l}`).join('\n'));
  if (dry) continue;

  for (const mode of modes) {
    const start = performance.now();
    try {
      const output = await runPipeline({
        frames,
        transcript: stt.transcript,
        mode,
        call: (req) => callClaude({ ...req, fetchFn: fetch, apiKey, onRetry: (r) => log(`   ↻ ${r.status}, thử lại sau ${Math.round(r.waitMs / 1000)}s`) }),
      });
      const seconds = mediaSec + (performance.now() - start) / 1000;
      const g = grade(gold, output);
      runs.push({ file, mode, seconds, cost: output.cost, stt: stt.engine, frames: frames.length, ...g, notes: output.notes });
      log(`   ${MODES[mode].label}: đúng ${g.correct}/${g.total} · sót ${g.missed} · (?) ${g.flagged} · ${seconds.toFixed(0)}s · ${formatUsd(output.cost)}`);
      g.rows.filter((r) => !r.correct).forEach((r) => log(`      ✗ câu ${r.number}: ra "${r.got}", đúng là "${r.expected}"`));
    } catch (e) {
      runs.push({ file, mode, error: e.message, total: Object.keys(gold).length, correct: 0, missed: Object.keys(gold).length, flagged: 0, seconds: 0, cost: 0, rows: [] });
      log(`   ${MODES[mode].label}: ❌ ${e.message}`);
    }
  }
}
if (dry || !runs.length) process.exit(0);

const summarize = (mode) => {
  const rs = runs.filter((r) => r.mode === mode);
  const sum = (field) => rs.reduce((n, r) => n + r[field], 0);
  const total = sum('total');
  return `| ${MODES[mode].label} | ${rs.length} | ${total} | ${pct(sum('correct'), total)} (${sum('correct')}/${total}) | ${pct(sum('missed'), total)} | ${pct(sum('flagged'), total)} | ${(sum('seconds') / rs.length).toFixed(0)}s | ${formatUsd(sum('cost') / rs.length)} |`;
};
const today = new Date().toISOString().slice(0, 10);
const sttEngines = [...new Set(runs.map((r) => r.stt).filter(Boolean))].join(', ');
const report = `# Kết quả eval

Sinh tự động bởi \`npm run eval\` ngày ${today}. Đổi prompt hoặc model thì chạy lại.

- Model: Chính xác = trích \`${MODES.accurate.extract.model}\`, giải \`${MODES.accurate.solve.model}\` + đối chiếu \`${MODES.accurate.crossCheck.model}\`, trọng tài \`${MODES.accurate.referee.model}\`; Nhanh = \`${MODES.fast.solve.model}\`.
- Ảnh: cạnh dài tối đa ${maxEdge}px, lọc trùng ngưỡng độ sáng ${FRAME.lumaDiff}, tỉ lệ ${FRAME.minChangedRatio * 100}%.
- STT đã dùng: ${sttEngines || 'không'} (Gemini \`${GEMINI.model}\` nếu có key, không thì Whisper \`${WHISPER.model}\`).
- Thời gian gồm cả cắt khung + STT trên máy tính chạy eval (điện thoại sẽ chậm hơn ở khâu này).
- ⚠️ Video mẫu là video tự tạo (chữ rõ, giọng TTS) nên điểm gần mức trần; số liệu có ý nghĩa nhất khi có video thật trong \`eval/videos/\`.

## Tổng hợp

| Chế độ | Số video | Số câu | Đúng | Sót | Đánh dấu (?) | Thời gian TB/video | Chi phí TB/video |
|---|---|---|---|---|---|---|---|
${modes.map(summarize).join('\n')}

## Từng video

| Video | Chế độ | Khung | STT | Đúng | Sót | (?) | Thời gian | Chi phí | Câu sai |
|---|---|---|---|---|---|---|---|---|---|
${runs
  .map((r) =>
    r.error
      ? `| ${r.file} | ${MODES[r.mode].label} | | | ❌ ${r.error.replace(/\|/g, '/')} | | | | | |`
      : `| ${r.file} | ${MODES[r.mode].label} | ${r.frames} | ${r.stt} | ${r.correct}/${r.total} | ${r.missed} | ${r.flagged} | ${r.seconds.toFixed(0)}s | ${formatUsd(r.cost)} | ${r.rows.filter((x) => !x.correct).map((x) => `${x.number}: ${x.got} ≠ ${x.expected}`).join('; ') || '—'} |`,
  )
  .join('\n')}
`;
await writeFile(path.join(here, 'RESULTS.md'), report);
log(`\n📝 Đã ghi eval/RESULTS.md`);
