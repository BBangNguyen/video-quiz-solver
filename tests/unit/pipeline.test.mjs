import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS } from '../../src/core/constants.js';
import { ClaudeError } from '../../src/core/claude-client.js';
import { EXTRACT_SCHEMA, mergeQuestions, uniquifyNumbers } from '../../src/core/extract-questions.js';
import { SOLVE_SCHEMA, selectSolveFrames } from '../../src/core/solve-questions.js';
import { createMemoryStore, runPipeline } from '../../src/core/pipeline.js';

const question = (number, extra = {}) => ({
  number,
  type: 'multiple_choice',
  text: `Question ${number}`,
  options: [
    { label: 'A', text: 'x' },
    { label: 'B', text: 'y' },
  ],
  passage_id: '',
  frame_times: ['00:01'],
  transcript_excerpt: '',
  incomplete: false,
  ...extra,
});
const ans = (number, answer, confidence = 'high') => ({ number, answer, confidence, explanation: 'e' });
const frames = [{ t: 1, data: 'AAAA' }];
const isReferee = (req) => req.content.at(-1).text.includes('You are the referee');

// Giả lập Claude: trả lời theo schema + model, ghi lại mọi request.
function fakeClaude({ questions, opus, sonnet, referee = [], fail = {} }) {
  const calls = [];
  const call = async (req) => {
    const kind = req.schema === EXTRACT_SCHEMA ? 'extract' : isReferee(req) ? 'referee' : req.model === MODELS.opus ? 'opus' : 'sonnet';
    calls.push({ kind, req });
    if (fail[kind]) throw fail[kind];
    const usage = { model: req.model, input_tokens: 1000, output_tokens: 100 };
    if (kind === 'extract') return { data: { passages: [], questions }, usage };
    return { data: { answers: { opus, sonnet, referee }[kind] }, usage };
  };
  return { call, calls, kinds: () => calls.map((c) => c.kind).sort() };
}

test('Chính xác: hai lượt trùng nhau → không gọi trọng tài', async () => {
  const fake = fakeClaude({ questions: [question('1'), question('2')], opus: [ans('1', 'A'), ans('2', 'B')], sonnet: [ans('1', 'a'), ans('2', 'B.')] });
  const out = await runPipeline({ frames, transcript: '', mode: 'accurate', call: fake.call });
  assert.deepEqual(fake.kinds(), ['extract', 'opus', 'sonnet']);
  assert.deepEqual(out.results.map((r) => [r.answer, r.uncertain]), [['A', false], ['B', false]]);
  assert.equal(fake.calls.find((c) => c.kind === 'opus').req.schema, SOLVE_SCHEMA);
});

test('Chính xác: lệch nhau → trọng tài Opus chỉ nhận các câu tranh chấp kèm cả hai lập luận', async () => {
  const fake = fakeClaude({
    questions: [question('1'), question('2')],
    opus: [ans('1', 'A'), ans('2', 'A')],
    sonnet: [ans('1', 'A'), ans('2', 'B')],
    referee: [ans('2', 'B')],
  });
  const out = await runPipeline({ frames, transcript: '[00:01] hello', mode: 'accurate', call: fake.call });
  const ref = fake.calls.find((c) => c.kind === 'referee').req;
  assert.equal(ref.model, MODELS.opus);
  const prompt = ref.content.at(-1).text;
  assert.match(prompt, /Question 2:\n- Solver 1: "A"[^\n]*\n- Solver 2: "B"/);
  assert.doesNotMatch(prompt, /Question 1:/);
  assert.deepEqual(out.results.map((r) => [r.answer, r.source]), [['A', 'agreed'], ['B', 'referee']]);
  assert.equal(out.usages.filter(Boolean).length, 4);
  assert.ok(out.cost > 0);
});

test('Nhanh: đúng một lượt Sonnet cho mỗi bước, không đối chiếu', async () => {
  const fake = fakeClaude({ questions: [question('1')], sonnet: [ans('1', 'B', 'low')] });
  const out = await runPipeline({ frames, transcript: '', mode: 'fast', call: fake.call });
  assert.deepEqual(fake.calls.map((c) => [c.kind, c.req.model]), [['extract', MODELS.sonnet], ['sonnet', MODELS.sonnet]]);
  assert.deepEqual([out.results[0].answer, out.results[0].uncertain], ['B', true]);
});

test('không tìm thấy câu hỏi → dừng sau bước trích, không gọi giải', async () => {
  const fake = fakeClaude({ questions: [] });
  const out = await runPipeline({ frames, transcript: '', mode: 'accurate', call: fake.call });
  assert.deepEqual(fake.kinds(), ['extract']);
  assert.deepEqual(out.results, []);
});

test('rớt mạng ở bước giải rồi chạy lại: không trích lại, chỉ chạy tiếp bước dở', async () => {
  const store = createMemoryStore();
  const script = { questions: [question('1')], opus: [ans('1', 'A')], sonnet: [ans('1', 'A')] };
  const broken = fakeClaude({ ...script, fail: { opus: new ClaudeError('Mất kết nối', 'network') } });
  await assert.rejects(runPipeline({ frames, transcript: '', mode: 'accurate', call: broken.call, store }), (e) => e.kind === 'network');
  await new Promise((r) => setTimeout(r, 0)); // chờ lượt Sonnet đang chạy song song lưu xong
  const resumed = fakeClaude(script);
  const out = await runPipeline({ frames, transcript: '', mode: 'accurate', call: resumed.call, store });
  assert.deepEqual(resumed.kinds(), ['opus'], 'trích và lượt Sonnet lấy từ checkpoint');
  assert.equal(out.results[0].answer, 'A');
  assert.equal(out.usages.filter(Boolean).length, 3, 'chi phí các bước trước khi gián đoạn vẫn được tính');
});

test('lượt đối chiếu bị từ chối → vẫn trả kết quả một lượt kèm ghi chú', async () => {
  const fake = fakeClaude({ questions: [question('1')], opus: [ans('1', 'A')], fail: { sonnet: new ClaudeError('refused', 'refusal') } });
  const out = await runPipeline({ frames, transcript: '', mode: 'accurate', call: fake.call });
  assert.equal(out.results[0].answer, 'A');
  assert.match(out.notes[0], /Không đối chiếu chéo được/);
});

test('sai key → lỗi nổi lên nguyên vẹn', async () => {
  const fake = fakeClaude({ questions: [], fail: { extract: new ClaudeError('Sai API key Claude (401)', 'auth', 401) } });
  await assert.rejects(runPipeline({ frames, transcript: '', mode: 'fast', call: fake.call }), (e) => e.kind === 'auth');
});

test('quá nhiều khung → trích theo lô và gộp câu hỏi theo số, bản đầy đủ hơn thắng', async () => {
  const many = Array.from({ length: 170 }, (_, t) => ({ t, data: 'AAAA' }));
  const batches = [
    [question('1'), question('2', { text: 'Half', incomplete: true })],
    [question('2', { text: 'Half but now complete' }), question('3')],
    [question('3'), question('4')],
  ];
  const calls = [];
  const call = async (req) => {
    calls.push(req);
    const usage = { model: req.model, input_tokens: 1, output_tokens: 1 };
    if (req.schema === EXTRACT_SCHEMA) return { data: { passages: [], questions: batches[calls.length - 1] }, usage };
    return { data: { answers: ['1', '2', '3', '4'].map((n) => ans(n, 'A')) }, usage };
  };
  const out = await runPipeline({ frames: many, transcript: '', mode: 'fast', call });
  assert.equal(calls.filter((c) => c.schema === EXTRACT_SCHEMA).length, 3);
  assert.match(calls[1].content.at(-1).text, /part 2 of 3/);
  assert.deepEqual(out.questions.map((q) => [q.number, q.text]), [['1', 'Question 1'], ['2', 'Half but now complete'], ['3', 'Question 3'], ['4', 'Question 4']]);
  const solveImages = calls.at(-1).content.filter((b) => b.type === 'image').length;
  assert.ok(solveImages <= 80, `bước giải gửi ${solveImages} ảnh, không vượt giới hạn mỗi request`);
});

test('uniquifyNumbers / mergeQuestions: trùng số trong cùng một lô không bị nuốt mất câu', () => {
  assert.deepEqual(uniquifyNumbers([question('1'), question('1'), question('2')]).map((q) => q.number), ['1', '1 (2)', '2']);
  assert.equal(mergeQuestions([], [question('1'), question('1')]).length, 2);
});

test('selectSolveFrames: ưu tiên khung quanh mốc thời gian của câu hỏi', () => {
  const many = Array.from({ length: 200 }, (_, t) => ({ t }));
  const picked = selectSolveFrames(many, [question('1', { frame_times: ['01:40', '01:41'] })], 80);
  assert.deepEqual(picked.map((f) => f.t), [99, 100, 101, 102]);
  assert.equal(selectSolveFrames(many.slice(0, 50), [question('1')], 80).length, 50);
});
