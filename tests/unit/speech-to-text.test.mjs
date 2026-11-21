import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, geminiResponseToSegments, isSilent, transcribe, whisperChunksToSegments } from '../../src/core/speech-to-text.js';
import { formatTime, segmentsToTranscript, wordsToSegments } from '../../src/core/transcript-format.js';
import { costOfUsage, totalCost } from '../../src/core/cost.js';

const tone = (seconds = 1) => Float32Array.from({ length: 16000 * seconds }, (_, i) => Math.sin(i / 10) * 0.5);
const geminiBody = {
  steps: [
    {
      type: 'model_output',
      content: [
        {
          type: 'text',
          text: 'Hello world. Next question',
          annotations: [
            { type: 'word_info', text: 'Hello', start_offset: '0.100s' },
            { type: 'word_info', text: 'world.', start_offset: '0.500s' },
            { type: 'word_info', text: 'Next', start_offset: '64.000s' },
            { type: 'word_info', text: 'question', start_offset: '64.400s' },
          ],
        },
      ],
    },
  ],
};

test('formatTime và transcript có mốc [mm:ss]', () => {
  assert.equal(formatTime(0), '00:00');
  assert.equal(formatTime(125.9), '02:05');
  assert.equal(segmentsToTranscript(geminiResponseToSegments(geminiBody, 0)), '[00:00] Hello world.\n[01:04] Next question');
});

test('offset của đoạn audio được cộng vào mốc thời gian; thiếu timestamp từ thì vẫn giữ text', () => {
  assert.equal(geminiResponseToSegments(geminiBody, 300)[0].t, 300.1);
  assert.deepEqual(geminiResponseToSegments({ steps: [{ content: [{ type: 'text', text: 'plain' }] }] }, 300), [{ t: 300, text: 'plain' }]);
  assert.deepEqual(geminiResponseToSegments({}, 0), []);
});

test('wordsToSegments ngắt dòng khi im lặng dài hoặc dòng quá dài', () => {
  const words = [0, 1, 2, 9, 9.5].map((t) => ({ t, text: `w${t}` }));
  assert.deepEqual(wordsToSegments(words).map((s) => s.text), ['w0 w1 w2', 'w9 w9.5']);
});

test('encodeWav tạo header WAV PCM16 mono 16kHz', () => {
  const wav = encodeWav(Float32Array.from([0, 1, -1]));
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(wav.length, 44 + 6);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.deepEqual([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)], [0, 32767, -32768]);
});

test('video không có tiếng → không gọi STT nào', async () => {
  assert.equal(isSilent(null), true);
  assert.equal(isSilent(new Float32Array(16000)), true);
  const fail = () => assert.fail('không được gọi');
  assert.deepEqual(await transcribe({ pcm: null, geminiKey: 'k', fetchFn: fail, whisper: fail }), { transcript: '', engine: 'none', warnings: [] });
});

test('có key Gemini → dùng Gemini, gửi WAV inline đúng dạng', async () => {
  let sent;
  const fetchFn = async (url, init) => {
    sent = { url, headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify(geminiBody), { status: 200 });
  };
  const out = await transcribe({ pcm: tone(), geminiKey: 'g-key', fetchFn, whisper: () => assert.fail('không được gọi Whisper') });
  assert.equal(out.engine, 'gemini');
  assert.match(out.transcript, /^\[00:00\] Hello world\./);
  assert.equal(sent.headers['x-goog-api-key'], 'g-key');
  assert.equal(sent.body.model, 'models/gemini-3.5-transcribe');
  assert.equal(sent.body.input[0].mime_type, 'audio/wav');
  assert.equal(atob(sent.body.input[0].data).slice(0, 4), 'RIFF');
});

test('không có key Gemini → Whisper fallback', async () => {
  const whisper = async () => whisperChunksToSegments([{ timestamp: [2.5, 4], text: ' She went home.' }]);
  const out = await transcribe({ pcm: tone(), geminiKey: '', fetchFn: () => assert.fail('không được gọi Gemini'), whisper });
  assert.deepEqual([out.engine, out.transcript], ['whisper', '[00:02] She went home.']);
});

test('Gemini lỗi → chuyển sang Whisper kèm cảnh báo; Whisper cũng lỗi → bỏ qua audio, không treo', async () => {
  const fetchFn = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  const ok = await transcribe({ pcm: tone(), geminiKey: 'bad', fetchFn, whisper: async () => [{ t: 0, text: 'hi' }] });
  assert.equal(ok.engine, 'whisper');
  assert.match(ok.warnings[0], /Gemini Transcribe lỗi \(API key not valid\)/);
  const none = await transcribe({ pcm: tone(), geminiKey: '', fetchFn, whisper: async () => Promise.reject(new Error('CDN bị chặn')) });
  assert.deepEqual([none.engine, none.transcript], ['none', '']);
  assert.match(none.warnings[0], /CDN bị chặn/);
});

test('chi phí ước tính theo usage và bảng giá', () => {
  assert.equal(costOfUsage({ model: 'claude-opus-5-5', input_tokens: 1_000_000, output_tokens: 100_000 }), 6);
  assert.equal(costOfUsage({ model: 'claude-sonnet-5-5', input_tokens: 500_000, output_tokens: 0 }), 1);
  assert.equal(costOfUsage({ model: 'unknown', input_tokens: 5 }), 0);
  assert.equal(totalCost([{ model: 'claude-sonnet-5-5', input_tokens: 500_000 }, null]), 1);
});
