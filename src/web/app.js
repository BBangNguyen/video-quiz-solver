// Điều khiển giao diện: chọn video → cắt khung + nghe audio (song song) → pipeline Claude → kết quả.
// Mọi bước lưu vào IndexedDB nên khoá máy / đổi app / rớt mạng rồi mở lại sẽ chạy tiếp từ bước dở.
import { MODES } from '../core/constants.js';
import { ClaudeError, callClaude } from '../core/claude-client.js';
import { formatUsd } from '../core/cost.js';
import { displayAnswer, formatAnswerSheet } from '../core/cross-check.js';
import { runPipeline } from '../core/pipeline.js';
import { transcribe } from '../core/speech-to-text.js';
import { decodeAudioTo16k } from './audio-pcm.js';
import { history, kv } from './job-store.js';
import { extractFrames } from './video-frames.js';
import { whisperInWorker } from './whisper-client.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// ── Cài đặt (localStorage) ────────────────────────────────────────────────
const SETTING_KEYS = { claudeKey: 'vqs.claudeKey', geminiKey: 'vqs.geminiKey', mode: 'vqs.mode', listening: 'vqs.listening' };
const readSetting = (name) => {
  try {
    return localStorage.getItem(SETTING_KEYS[name]) ?? '';
  } catch {
    return ''; // chế độ riêng tư chặn localStorage
  }
};
const writeSetting = (name, value) => {
  try {
    localStorage.setItem(SETTING_KEYS[name], value);
    return true;
  } catch {
    return false;
  }
};
const currentMode = () => (MODES[readSetting('mode')] ? readSetting('mode') : 'accurate');

// ── Trạng thái phiên chạy ─────────────────────────────────────────────────
let runToken = 0; // tăng lên khi huỷ / chạy mới → kết quả của phiên cũ bị bỏ qua
let running = false;
let clockTimer = null;
let wakeLock = null;
let retryAction = null;
let lastFile = null;
let shownResult = null;

const VIEWS = ['home', 'settings', 'progress', 'result', 'history'];
function show(view) {
  VIEWS.forEach((name) => ($(`view-${name}`).hidden = name !== view));
  window.scrollTo(0, 0);
  if (view === 'home') refreshHomeNotice();
}

function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (node.hidden = true), 2200);
}

// ── Màn tiến độ ──────────────────────────────────────────────────────────
const STEP_LABELS = { frames: 'Đang cắt khung hình', audio: 'Đang nghe audio', extract: 'Đang trích câu hỏi', solve: 'Đang giải', crosscheck: 'Đang đối chiếu' };
const stepNode = (name) => document.querySelector(`#steps [data-step="${name}"]`);

function setStep(name, status, detail = '', label = STEP_LABELS[name]) {
  const node = stepNode(name);
  node.className = status === 'pending' ? '' : `is-${status}`;
  node.querySelector('b').textContent = label;
  node.querySelector('small').textContent = detail;
}

function resetSteps(mode) {
  Object.keys(STEP_LABELS).forEach((name) => setStep(name, 'pending'));
  stepNode('crosscheck').hidden = !MODES[mode].crossCheck;
  $('progress-error').hidden = true;
  $('btn-retry').hidden = true;
  $('progress-title').textContent = `Đang xử lý · ${MODES[mode].label}`;
}

function showProgressError(message, { warn = false, onRetry = null } = {}) {
  const node = $('progress-error');
  node.textContent = message;
  node.className = `notice ${warn ? 'notice-warn' : 'notice-error'}`;
  node.hidden = false;
  retryAction = onRetry;
  $('btn-retry').hidden = !onRetry;
}

async function requestWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null; // trình duyệt từ chối (pin yếu, tab ẩn…) — đã có dòng nhắc giữ màn hình mở
  }
}

function beginRun(job) {
  running = true;
  resetSteps(job.mode);
  show('progress');
  clearInterval(clockTimer);
  const tick = () => ($('clock').textContent = String(Math.floor((Date.now() - job.startedAt) / 1000)));
  tick();
  clockTimer = setInterval(tick, 250);
  requestWakeLock();
  return ++runToken;
}

function endRun() {
  running = false;
  clearInterval(clockTimer);
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ── Khâu media: cắt khung + nghe audio, chạy song song ────────────────────
async function framesTask(file) {
  setStep('frames', 'active', '', 'Đang cắt khung hình 0%');
  const frames = await extractFrames(file, {
    onProgress: (ratio) => setStep('frames', 'active', stepNode('frames').querySelector('small').textContent, `Đang cắt khung hình ${Math.round(ratio * 100)}%`),
    onNotice: (text) => setStep('frames', 'active', text, stepNode('frames').querySelector('b').textContent),
  });
  setStep('frames', 'done', `Giữ ${frames.length} khung sau khi lọc trùng`, 'Đã cắt khung hình');
  return frames;
}

async function audioTask(file) {
  if (readSetting('listening') !== '1') {
    setStep('audio', 'skipped', 'Đã tắt "Video có bài nghe" trong ⚙️ — chỉ giải theo hình', 'Bỏ qua audio');
    return { transcript: '', engine: 'none', notes: [] };
  }
  setStep('audio', 'active');
  try {
    const { pcm, warning } = await decodeAudioTo16k(file);
    const stt = await transcribe({
      pcm,
      geminiKey: readSetting('geminiKey'),
      fetchFn: (...args) => fetch(...args),
      whisper: (samples) => whisperInWorker(samples, (status) => setStep('audio', 'active', status)),
    });
    const notes = [warning, ...stt.warnings].filter(Boolean);
    const summary = { gemini: 'Đã nghe bằng Gemini Transcribe', whisper: 'Đã nghe bằng Whisper trên máy', none: notes[0] ?? 'Video không có tiếng — chỉ giải theo hình' }[stt.engine];
    setStep('audio', stt.engine === 'none' ? 'skipped' : 'done', summary, stt.engine === 'none' ? 'Bỏ qua audio' : 'Đã nghe audio');
    return { transcript: stt.transcript, engine: stt.engine, notes };
  } catch (e) {
    setStep('audio', 'skipped', `Lỗi đọc audio (${e.message}) — chỉ giải theo hình`, 'Bỏ qua audio');
    return { transcript: '', engine: 'none', notes: [`Không đọc được audio: ${e.message}`] };
  }
}

async function startJob(file) {
  if (!file) return;
  if (running) return toast('Đang xử lý một video khác');
  if (!readSetting('claudeKey')) return openSettings('Nhập Claude API key trước khi giải nhé.');
  lastFile = file;
  const job = { mode: currentMode(), fileName: file.name, startedAt: Date.now(), stage: 'media' };
  const token = beginRun(job);
  try {
    await kv.clear();
    await kv.set('job', job);
    const [frames, audio] = await Promise.all([framesTask(file), audioTask(file)]);
    if (token !== runToken) return;
    if (!frames.length) throw new Error('Không lấy được khung hình nào từ video.');
    await kv.set('media', { frames, transcript: audio.transcript, engine: audio.engine, notes: audio.notes });
    await kv.set('job', { ...job, stage: 'pipeline' });
    await solve(token);
  } catch (e) {
    fail(token, e, () => startJob(lastFile));
  }
}

// ── Khâu Claude: chạy (hoặc chạy tiếp) từ dữ liệu đã lưu ───────────────────
function onPipelineProgress(step, detail, mode) {
  if (step === 'extract') {
    setStep('extract', 'active', detail?.total > 1 ? `Phần ${detail.index}/${detail.total}` : '');
  } else if (step === 'solve') {
    setStep('extract', 'done', '', 'Đã trích câu hỏi');
    setStep('solve', 'active', MODES[mode].crossCheck ? 'Hai model giải độc lập' : '');
  } else if (step === 'crosscheck') {
    setStep('solve', 'done', '', 'Đã giải');
    setStep('crosscheck', 'active', detail.disputes ? `${detail.disputes} câu lệch nhau → hỏi trọng tài` : 'Hai lượt giải trùng khớp');
  }
}

/** Chờ tới khi nên thử lại: có mạng lại, quay lại app, bấm "Thử lại", hoặc hết giờ chờ. */
function waitForReconnect() {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      document.removeEventListener('visibilitychange', onVisible);
      $('progress-error').hidden = true;
      $('btn-retry').hidden = true;
      resolve();
    };
    const onVisible = () => document.visibilityState === 'visible' && done();
    const timer = setTimeout(() => navigator.onLine && document.visibilityState === 'visible' && done(), 8000);
    window.addEventListener('online', done);
    document.addEventListener('visibilitychange', onVisible);
    showProgressError('Mất kết nối mạng. Kết quả các bước trước đã được lưu — app sẽ tự chạy tiếp khi có mạng lại.', { warn: true, onRetry: done });
  });
}

async function solve(token) {
  const [job, media] = await Promise.all([kv.get('job'), kv.get('media')]);
  setStep('frames', 'done', `Giữ ${media.frames.length} khung sau khi lọc trùng`, 'Đã cắt khung hình');
  if (stepNode('audio').className === '') setStep('audio', media.transcript ? 'done' : 'skipped', '', media.transcript ? 'Đã nghe audio' : 'Bỏ qua audio');
  let active = 'extract';
  for (;;) {
    try {
      const output = await runPipeline({
        frames: media.frames,
        transcript: media.transcript,
        mode: job.mode,
        store: { get: (key) => kv.get(`step:${key}`), set: (key, value) => kv.set(`step:${key}`, value) },
        onProgress: (step, detail) => {
          active = step;
          if (token === runToken) onPipelineProgress(step, detail, job.mode);
        },
        call: (req) =>
          callClaude({
            ...req,
            fetchFn: (...args) => fetch(...args),
            apiKey: readSetting('claudeKey'),
            onRetry: (r) => token === runToken && setStep(active, 'active', `API đang bận (${r.status}) — thử lại sau ${Math.ceil(r.waitMs / 1000)}s`),
          }),
      });
      if (token !== runToken) return;
      await finishJob(job, media, output);
      return;
    } catch (e) {
      if (token !== runToken) return;
      if (!(e instanceof ClaudeError && e.kind === 'network')) throw e;
      await waitForReconnect();
      if (token !== runToken) return;
    }
  }
}

async function finishJob(job, media, output) {
  const entry = {
    createdAt: job.startedAt,
    seconds: Math.round((Date.now() - job.startedAt) / 1000),
    mode: job.mode,
    fileName: job.fileName,
    engine: media.engine,
    questions: output.questions,
    passages: output.passages,
    results: output.results,
    cost: output.cost,
    notes: [...(media.notes ?? []), ...output.notes],
  };
  await history.add(entry);
  await kv.clear();
  endRun();
  showResult(entry);
}

function fail(token, error, onRetry) {
  if (token !== runToken) return;
  endRun();
  const activeStep = document.querySelector('#steps .is-active');
  if (activeStep) activeStep.className = 'is-failed';
  showProgressError(error?.message ?? String(error), { onRetry });
}

async function resumeJob() {
  const job = await kv.get('job');
  if (!job) return show('home');
  const token = beginRun(job);
  try {
    await solve(token);
  } catch (e) {
    fail(token, e, resumeJob);
  }
}

async function cancelJob() {
  runToken++;
  endRun();
  await kv.clear().catch(() => {});
  show('home');
}

// ── Kết quả ──────────────────────────────────────────────────────────────
function answerRow(result, question, passage, index) {
  const summary = el('summary', {}, [
    el('span', { className: 'num', textContent: `${result.number}.` }),
    el('span', { className: 'ans' }, [displayAnswer(result.answer, question), ...(result.uncertain ? [' ', el('span', { className: 'unsure', textContent: '(?)' })] : [])]),
  ]);
  const questionText = question ? [question.text, ...question.options.map((o) => `${o.label}. ${o.text}`)].join('\n') : '(không có nội dung câu hỏi)';
  const detail = el('div', { className: 'detail' }, [
    ...(passage ? [el('p', { textContent: passage.text })] : []),
    el('p', { className: 'q', textContent: questionText }),
    el('p', { className: 'why', textContent: result.explanation ?? '' }),
  ]);
  const item = el('li', {}, [el('details', {}, [summary, detail])]);
  item.style.setProperty('--i', index);
  return item;
}

function showResult(entry) {
  shownResult = entry;
  const when = new Date(entry.createdAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
  $('result-meta').textContent = `${when} · ${MODES[entry.mode].label}`;
  $('result-total').replaceChildren('Tổng: ', el('b', { textContent: String(entry.results.length) }), ' câu');
  const notes = entry.results.length ? entry.notes : ['Không tìm thấy câu hỏi nào trong video. Thử quay gần hơn, rõ chữ hơn.', ...entry.notes];
  $('result-notes').replaceChildren(...notes.map((text) => el('p', { className: 'notice notice-warn', textContent: text })));
  const questions = new Map(entry.questions.map((q) => [q.number, q]));
  const passages = new Map(entry.passages.map((p) => [p.id, p]));
  $('answers').hidden = !entry.results.length;
  $('answers').replaceChildren(...entry.results.map((r, i) => answerRow(r, questions.get(r.number), passages.get(questions.get(r.number)?.passage_id), i)));
  const heard = { gemini: 'nghe bằng Gemini', whisper: 'nghe bằng Whisper', none: 'không dùng audio' }[entry.engine] ?? '';
  $('result-cost').textContent = `Chi phí Claude ước tính: ${formatUsd(entry.cost)} · ${entry.seconds} giây · ${heard}`;
  $('btn-copy').disabled = !entry.results.length;
  show('result');
}

async function copyAnswers() {
  const text = formatAnswerSheet(shownResult.results, shownResult.questions);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API bị chặn (http, webview cũ) → cách cũ qua textarea
    const area = el('textarea', { value: text, readOnly: true });
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) return toast('Không copy được — hãy chọn và copy thủ công');
  }
  toast('Đã copy đáp án');
}

// ── Lịch sử ──────────────────────────────────────────────────────────────
async function openHistory() {
  const entries = await history.all();
  $('history-list').replaceChildren(
    ...entries.map((entry) => {
      const when = new Date(entry.createdAt).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
      const button = el('button', { type: 'button' }, [
        el('b', { textContent: `${entry.results.length} câu · ${MODES[entry.mode].label}` }),
        el('small', { textContent: `${when} · ${entry.fileName || 'video'} · ${formatUsd(entry.cost)}` }),
      ]);
      button.addEventListener('click', () => showResult(entry));
      return el('li', {}, [button]);
    }),
  );
  $('history-empty').hidden = entries.length > 0;
  $('btn-clear-history').hidden = entries.length === 0;
  $('btn-clear-history').querySelector('span').textContent = 'Xoá lịch sử';
  show('history');
}

// ── Trang chính + cài đặt ─────────────────────────────────────────────────
function homeNotice(text, actions = []) {
  const node = $('home-notice');
  node.hidden = !text;
  node.replaceChildren(text ?? '', ...actions.flatMap(([label, handler]) => [' ', Object.assign(el('button', { type: 'button', textContent: label }), { onclick: handler })]));
}

async function refreshHomeNotice() {
  if (running) return homeNotice('⏳ Đang xử lý một video.', [['Xem tiến độ', () => show('progress')]]);
  const job = await kv.get('job').catch(() => null);
  if (job?.stage === 'pipeline') return homeNotice('Có một bài đang xử lý dở.', [['Chạy tiếp', resumeJob], ['Bỏ', cancelJob]]);
  if (!readSetting('claudeKey')) return homeNotice('Chưa có Claude API key.', [['Mở cài đặt', () => openSettings()]]);
  return homeNotice(null);
}

function openSettings(message = '') {
  $('input-claude-key').value = readSetting('claudeKey');
  $('input-gemini-key').value = readSetting('geminiKey');
  $('input-listening').checked = readSetting('listening') === '1';
  $('settings-status').textContent = message;
  show('settings');
}

function saveSettings(event) {
  event.preventDefault();
  const ok = writeSetting('claudeKey', $('input-claude-key').value.trim()) && writeSetting('geminiKey', $('input-gemini-key').value.trim()) && writeSetting('listening', $('input-listening').checked ? '1' : '');
  if (!ok) return ($('settings-status').textContent = 'Không lưu được: trình duyệt đang chặn bộ nhớ (chế độ riêng tư?).');
  toast('Đã lưu cài đặt');
  show('home');
}

function bindEvents() {
  $('nav-home').addEventListener('click', () => show(running ? 'progress' : 'home'));
  $('nav-settings').addEventListener('click', () => openSettings());
  $('nav-history').addEventListener('click', openHistory);
  $('settings-form').addEventListener('submit', saveSettings);
  for (const id of ['input-record', 'input-pick']) {
    $(id).addEventListener('change', (event) => {
      const [file] = event.target.files;
      event.target.value = ''; // cho phép chọn lại đúng file đó
      startJob(file);
    });
  }
  document.querySelectorAll('input[name="mode"]').forEach((radio) => {
    radio.checked = radio.value === currentMode();
    radio.addEventListener('change', () => writeSetting('mode', radio.value));
  });
  $('btn-retry').addEventListener('click', () => retryAction?.());
  $('btn-cancel').addEventListener('click', cancelJob);
  $('btn-copy').addEventListener('click', copyAnswers);
  $('btn-again').addEventListener('click', () => show('home'));
  $('btn-clear-history').addEventListener('click', async (event) => {
    const label = event.currentTarget.querySelector('span');
    if (label.textContent !== 'Bấm lần nữa để xoá hết') return (label.textContent = 'Bấm lần nữa để xoá hết'); // thay cho confirm()
    await history.clear();
    openHistory();
  });
  document.addEventListener('visibilitychange', () => {
    if (running && document.visibilityState === 'visible' && (!wakeLock || wakeLock.released)) requestWakeLock();
  });
}

async function init() {
  bindEvents();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  const job = await kv.get('job').catch(() => null);
  if (job?.stage === 'pipeline' && readSetting('claudeKey')) return resumeJob(); // mở lại app → chạy tiếp bước đang dở
  if (job && job.stage !== 'pipeline') {
    await kv.clear();
    show('home');
    return homeNotice('Lần trước bị gián đoạn khi đang đọc video. Hãy chọn lại video đó.');
  }
  show('home');
}

init();
