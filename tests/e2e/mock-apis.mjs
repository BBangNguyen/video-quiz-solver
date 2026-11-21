// Giả lập Claude / Gemini / CDN cho Playwright — không có request thật nào ra ngoài.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const fixture = (name) => path.join(here, 'fixtures', name);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'retry-after' };

export const QUESTIONS = [
  { number: '1', type: 'multiple_choice', text: 'She ____ to school every day.', options: ['go', 'goes', 'going', 'gone'].map((text, i) => ({ label: 'ABCD'[i], text })), passage_id: '', frame_times: ['00:00'], transcript_excerpt: '', incomplete: false },
  { number: '2', type: 'fill_blank', text: 'Yesterday we ____ (go) to the cinema.', options: [], passage_id: '', frame_times: ['00:07'], transcript_excerpt: '', incomplete: false },
];
const answer = (number, value, confidence = 'high') => ({ number, answer: value, explanation: `Giải thích cho câu ${number}: ${value}`, confidence });
export const AGREED = [answer('1', 'B'), answer('2', 'went')];

export function sse(json, usage = { input_tokens: 20000, output_tokens: 1000 }) {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(json) } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

const kindOf = (body) => {
  if (body.output_config.format.schema.properties.questions) return 'extract';
  if (body.messages[0].content.at(-1).text.includes('You are the referee')) return 'referee';
  return body.model === 'claude-opus-5-5' ? 'opus' : 'sonnet';
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {object} [script] - đáp án theo loại request; `intercept(kind, nth, route)` trả true nếu tự xử lý
 * @returns {{kind: string, body: object}[]} danh sách request đã nhận (cập nhật dần)
 */
export async function mockClaude(page, script = {}) {
  const calls = [];
  const data = { extract: { passages: [], questions: QUESTIONS }, opus: { answers: AGREED }, sonnet: { answers: AGREED }, referee: { answers: [] }, ...script.data };
  await page.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const body = request.postDataJSON();
    const kind = kindOf(body);
    const nth = calls.filter((c) => c.kind === kind).length;
    calls.push({ kind, body, headers: request.headers() });
    if (await script.intercept?.(kind, nth, route)) return undefined;
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'text/event-stream' }, body: sse(data[kind]) });
  });
  return calls;
}

export const claudeError = (route, status, message, headers = {}) =>
  route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ type: 'error', error: { type: 'error', message } }) }).then(() => true);

export async function mockGemini(page) {
  const calls = [];
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    calls.push(route.request().postDataJSON());
    const words = ['Question', 'one.', 'She', 'blank', 'to', 'school.'].map((text, i) => ({ type: 'word_info', text, start_offset: `${(i * 0.4).toFixed(3)}s` }));
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'x', annotations: words }] }] }) });
  });
  return calls;
}

/** Lõi ffmpeg.wasm (~32MB) lấy từ node_modules thay vì tải CDN ở mỗi test. */
export async function serveFfmpegCoreLocally(page) {
  await page.route('https://cdn.jsdelivr.net/npm/@ffmpeg/core@*/dist/esm/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const body = await readFile(path.join(here, '..', '..', 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', name));
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }, body });
  });
}

/** Thay transformers.js bằng module giả: kiểm tra đường dây Whisper fallback mà không tải model thật. */
export async function stubWhisper(page) {
  await page.route('https://cdn.jsdelivr.net/npm/@huggingface/transformers@*/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'text/javascript' },
      body: `export async function pipeline(task, model, opts) {
        opts?.progress_callback?.({ status: 'progress', progress: 50 });
        return async (pcm) => ({ text: '', chunks: [{ timestamp: [1.2, 3], text: ' whisper heard ' + pcm.length + ' samples' }] });
      }`,
    }),
  );
}

export const blockCdns = (page) => Promise.all(['https://cdn.jsdelivr.net/**', 'https://huggingface.co/**', 'https://*.hf.co/**'].map((url) => page.route(url, (route) => route.abort('blockedbyclient'))));

export async function openApp(page, { claudeKey = 'test-claude-key', geminiKey = '', mode = 'accurate', listening = '1' } = {}) {
  await page.addInitScript(
    ([c, g, m, l]) => {
      if (localStorage.getItem('vqs.seeded')) return;
      localStorage.setItem('vqs.seeded', '1');
      localStorage.setItem('vqs.claudeKey', c);
      localStorage.setItem('vqs.geminiKey', g);
      localStorage.setItem('vqs.mode', m);
      localStorage.setItem('vqs.listening', l);
    },
    [claudeKey, geminiKey, mode, listening],
  );
  page.on('dialog', (dialog) => {
    throw new Error(`App không được dùng alert/confirm/prompt: ${dialog.message()}`);
  });
  await page.goto('./');
}

export const pickVideo = (page, name = 'quiz.mp4') => page.setInputFiles('#input-pick', fixture(name));
