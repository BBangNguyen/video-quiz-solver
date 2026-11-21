import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeError, backoffMs, callClaude, parseSseChunk, parseStructuredResult, reduceMessageEvents } from '../../src/core/claude-client.js';

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const okStream = (json, usage = { input_tokens: 100, output_tokens: 20 }) =>
  sse([
    { type: 'message_start', message: { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: JSON.stringify(json).slice(0, 5) } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: JSON.stringify(json).slice(5) } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens } },
    { type: 'message_stop' },
  ]);
const response = (status, body, headers = {}) => new Response(body, { status, headers });
const queueFetch = (responses) => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchFn, calls };
};
const baseArgs = { apiKey: 'k', model: 'claude-sonnet-5-5', effort: 'high', system: 's', content: [], schema: {}, sleep: async () => {} };

test('parseSseChunk tách event trọn vẹn, giữ lại phần dư, chịu được \\r\\n', () => {
  const full = sse([{ type: 'ping' }, { type: 'message_stop' }]);
  const { events, rest } = parseSseChunk(full.slice(0, -10));
  assert.deepEqual(events, [{ type: 'ping' }]);
  assert.deepEqual(parseSseChunk(rest + full.slice(-10)).events, [{ type: 'message_stop' }]);
  assert.deepEqual(parseSseChunk('data: {"type":"ping"}\r\n\r\n').events, [{ type: 'ping' }]);
});

test('reduceMessageEvents chỉ gom text_delta, bỏ qua thinking', () => {
  const state = reduceMessageEvents(parseSseChunk(okStream({ answers: [] })).events);
  assert.equal(state.text, '{"answers":[]}');
  assert.equal(state.stopReason, 'end_turn');
  assert.deepEqual(state.usage, { input_tokens: 100, output_tokens: 20 });
});

test('parseStructuredResult: JSON hợp lệ, refusal, max_tokens, JSON hỏng', () => {
  assert.deepEqual(parseStructuredResult({ text: '{"a":1}', stopReason: 'end_turn' }), { a: 1 });
  assert.throws(() => parseStructuredResult({ text: 'Xin lỗi', stopReason: 'refusal' }), (e) => e.kind === 'refusal');
  assert.throws(() => parseStructuredResult({ text: '{"a":', stopReason: 'max_tokens' }), (e) => e.kind === 'truncated');
  assert.throws(() => parseStructuredResult({ text: '{"a":', stopReason: 'end_turn' }), (e) => e.kind === 'parse');
});

test('callClaude gửi đúng header + body theo docs hiện hành và trả data + usage', async () => {
  const { fetchFn, calls } = queueFetch([response(200, okStream({ ok: true }))]);
  const result = await callClaude({ ...baseArgs, fetchFn, schema: { type: 'object' } });
  assert.deepEqual(result.data, { ok: true });
  assert.deepEqual(result.usage, { model: 'claude-sonnet-5-5', input_tokens: 100, output_tokens: 20 });
  const { headers, body } = calls[0].init;
  assert.equal(headers['x-api-key'], 'k');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  const sent = JSON.parse(body);
  assert.deepEqual(sent.thinking, { type: 'adaptive' });
  assert.deepEqual(sent.output_config, { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } });
  assert.equal('tool_choice' in sent || 'temperature' in sent, false);
});

test('429 rồi 529 → retry có backoff, lần thứ ba thành công', async () => {
  const { fetchFn, calls } = queueFetch([
    response(429, JSON.stringify({ error: { message: 'rate limited' } }), { 'retry-after': '3' }),
    response(529, JSON.stringify({ error: { message: 'overloaded' } })),
    response(200, okStream({ ok: 1 })),
  ]);
  const waits = [];
  const retries = [];
  const result = await callClaude({ ...baseArgs, fetchFn, sleep: async (ms) => void waits.push(ms), onRetry: (r) => retries.push(r.status) });
  assert.deepEqual(result.data, { ok: 1 });
  assert.equal(calls.length, 3);
  assert.equal(waits[0], 3000, 'tôn trọng retry-after');
  assert.ok(waits[1] >= 4000 && waits[1] < 4500, 'backoff luỹ thừa cho lần 2');
  assert.deepEqual(retries, [429, 529]);
});

test('429 quá số lần retry → ném lỗi kèm nguyên văn message', async () => {
  const { fetchFn } = queueFetch(Array.from({ length: 3 }, () => response(429, JSON.stringify({ error: { message: 'Too many requests' } }))));
  await assert.rejects(callClaude({ ...baseArgs, fetchFn, maxRetries: 2 }), (e) => e.kind === 'api' && e.message === 'Too many requests');
});

test('401 → báo sai key, không retry', async () => {
  const { fetchFn, calls } = queueFetch([response(401, JSON.stringify({ error: { type: 'authentication_error', message: 'invalid x-api-key' } }))]);
  await assert.rejects(callClaude({ ...baseArgs, fetchFn }), (e) => e instanceof ClaudeError && e.kind === 'auth' && /Sai API key.*invalid x-api-key/.test(e.message));
  assert.equal(calls.length, 1);
});

test('lỗi khác → hiện nguyên văn error.message', async () => {
  const { fetchFn } = queueFetch([response(400, JSON.stringify({ error: { message: 'messages.0: image exceeds 10 MB maximum' } }))]);
  await assert.rejects(callClaude({ ...baseArgs, fetchFn }), (e) => e.kind === 'api' && e.status === 400 && e.message === 'messages.0: image exceeds 10 MB maximum');
});

test('rớt mạng → lỗi kind network', async () => {
  const { fetchFn } = queueFetch([new TypeError('Failed to fetch')]);
  await assert.rejects(callClaude({ ...baseArgs, fetchFn }), (e) => e.kind === 'network');
});

test('stream đứt giữa chừng (không có stop_reason) → lỗi network để chạy tiếp, không phải lỗi parse', async () => {
  const cut = sse([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"answers":[' } },
  ]);
  const { fetchFn } = queueFetch([response(200, cut)]);
  await assert.rejects(callClaude({ ...baseArgs, fetchFn }), (e) => e.kind === 'network');
});

test('overloaded_error giữa stream → retry', async () => {
  const { fetchFn, calls } = queueFetch([
    response(200, sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])),
    response(200, okStream({ ok: 2 })),
  ]);
  assert.deepEqual((await callClaude({ ...baseArgs, fetchFn })).data, { ok: 2 });
  assert.equal(calls.length, 2);
});

test('backoffMs tăng dần và có trần', () => {
  assert.equal(backoffMs(0, '0'), 0);
  assert.ok(backoffMs(1) >= 4000);
  assert.ok(backoffMs(20) <= 60_500);
});
