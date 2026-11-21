// Gọi Claude Messages API bằng fetch (stream SSE) — chạy được cả trên trình duyệt lẫn Node.
// Cú pháp theo docs hiện hành: thinking adaptive + output_config.effort + output_config.format (JSON schema).
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from './constants.js';

const RETRYABLE_STATUS = new Set([429, 529]);
const RETRYABLE_STREAM_ERRORS = new Set(['overloaded_error', 'rate_limit_error']);
const STREAM_IDLE_TIMEOUT_MS = 180_000;

export class ClaudeError extends Error {
  /** @param {string} message @param {'auth'|'network'|'api'|'refusal'|'truncated'|'parse'} kind @param {number} [status] */
  constructor(message, kind, status) {
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.status = status;
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (retryAfterHeader != null && retryAfterHeader !== '' && Number.isFinite(retryAfter)) return retryAfter * 1000;
  return Math.min(60_000, 2000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

/** Tách text SSE thành danh sách object JSON của các dòng `data:`. Trả phần dư chưa trọn event. */
export function parseSseChunk(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // Dòng data hỏng: bỏ qua event đó; nếu thiếu text thì bước parse JSON cuối sẽ báo lỗi rõ ràng.
    }
  }
  return { events, rest };
}

/** Gộp các event của một message stream thành {text, stopReason, usage, streamError}. */
export function reduceMessageEvents(events, acc = { text: '', stopReason: null, usage: {}, streamError: null }) {
  return events.reduce((state, ev) => {
    if (ev.type === 'message_start') return { ...state, usage: { ...state.usage, ...ev.message?.usage } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      return { ...state, text: state.text + ev.delta.text };
    }
    if (ev.type === 'message_delta') {
      return {
        ...state,
        stopReason: ev.delta?.stop_reason ?? state.stopReason,
        usage: { ...state.usage, ...ev.usage },
      };
    }
    if (ev.type === 'error') return { ...state, streamError: ev.error ?? { message: 'Lỗi stream không rõ' } };
    return state;
  }, acc);
}

async function readMessageStream(res, abortIdle) {
  let state = reduceMessageEvents([]);
  if (!res.body?.getReader) {
    return reduceMessageEvents(parseSseChunk(`${await res.text()}\n\n`).events, state);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const timer = setTimeout(abortIdle, STREAM_IDLE_TIMEOUT_MS);
    let chunk;
    try {
      chunk = await reader.read();
    } finally {
      clearTimeout(timer);
    }
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const parsed = parseSseChunk(chunk.done ? `${buffer}\n\n` : buffer);
    buffer = parsed.rest;
    state = reduceMessageEvents(parsed.events, state);
    if (chunk.done) return state;
  }
}

/** Parse JSON trả về từ structured output; ném ClaudeError rõ ràng theo stop_reason. */
export function parseStructuredResult({ text, stopReason }) {
  if (stopReason === 'refusal') throw new ClaudeError('Claude từ chối trả lời yêu cầu này (stop_reason: refusal).', 'refusal');
  if (stopReason === 'max_tokens') {
    throw new ClaudeError('Câu trả lời bị cắt vì chạm max_tokens — thử video ngắn hơn.', 'truncated');
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ClaudeError(`Claude trả về JSON không hợp lệ: ${e.message}`, 'parse');
  }
}

async function errorFromResponse(res) {
  const body = await res.json().catch(() => null);
  const message = body?.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401) return new ClaudeError(`Sai API key Claude (401): ${message}`, 'auth', 401);
  return new ClaudeError(message, 'api', res.status);
}

/**
 * @param {object} p
 * @param {typeof fetch} p.fetchFn
 * @param {string} p.apiKey
 * @param {string} p.model
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} p.effort
 * @param {string} p.system
 * @param {object[]} p.content - content blocks của một user message
 * @param {object} p.schema - JSON schema cho output_config.format
 * @returns {Promise<{data: any, usage: object}>}
 */
export async function callClaude({
  fetchFn,
  apiKey,
  model,
  effort,
  system,
  content,
  schema,
  maxTokens = 32000,
  maxRetries = 6,
  sleep = defaultSleep,
  onRetry = () => {},
}) {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
  };

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    let res;
    let stream;
    try {
      res = await fetchFn(ANTHROPIC_URL, { method: 'POST', headers, body, signal: controller.signal });
      if (res.ok) stream = await readMessageStream(res, () => controller.abort());
    } catch (e) {
      throw new ClaudeError(`Mất kết nối tới Claude API: ${e.message}`, 'network');
    }

    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        const wait = backoffMs(attempt, res.headers?.get?.('retry-after'));
        onRetry({ attempt: attempt + 1, status: res.status, waitMs: wait });
        await sleep(wait);
        continue;
      }
      throw await errorFromResponse(res);
    }

    if (stream.streamError) {
      if (RETRYABLE_STREAM_ERRORS.has(stream.streamError.type) && attempt < maxRetries) {
        const wait = backoffMs(attempt);
        onRetry({ attempt: attempt + 1, status: 529, waitMs: wait });
        await sleep(wait);
        continue;
      }
      throw new ClaudeError(stream.streamError.message ?? 'Lỗi stream không rõ', 'api');
    }

    // Kết nối đóng trước khi có stop_reason = đứt mạng giữa chừng → để bên gọi chạy tiếp, đừng coi là JSON hỏng.
    if (!stream.stopReason) throw new ClaudeError('Kết nối tới Claude API bị ngắt giữa chừng.', 'network');
    return { data: parseStructuredResult(stream), usage: { model, ...stream.usage } };
  }
}
