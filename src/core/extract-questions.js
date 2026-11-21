// Bước A — trích câu hỏi từ khung hình + transcript thành JSON (chưa giải).
import { FRAME } from './constants.js';
import { formatTime } from './transcript-format.js';

export const SYSTEM_PROMPT = `You are an expert English-exam assistant working from a video of an English test (a screen recording, or a phone camera pointed at a screen or paper).
You receive frames sampled from the video, each introduced by a label "Frame at mm:ss", and — when the video has speech — a speech-to-text transcript whose lines start with [mm:ss].
The frames are the ground truth for anything written on screen. The transcript is machine-generated and may contain recognition errors.`;

const STRING = { type: 'string' };

export const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    passages: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STRING, text: STRING },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: STRING,
          type: {
            type: 'string',
            enum: ['multiple_choice', 'fill_blank', 'true_false', 'matching', 'short_answer', 'other'],
          },
          text: STRING,
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: STRING, text: STRING },
              required: ['label', 'text'],
              additionalProperties: false,
            },
          },
          passage_id: STRING,
          frame_times: { type: 'array', items: STRING },
          transcript_excerpt: STRING,
          incomplete: { type: 'boolean' },
        },
        required: ['number', 'type', 'text', 'options', 'passage_id', 'frame_times', 'transcript_excerpt', 'incomplete'],
        additionalProperties: false,
      },
    },
  },
  required: ['passages', 'questions'],
  additionalProperties: false,
};

const EXTRACT_INSTRUCTIONS = `Task: list EVERY question of the test that appears in the frames or is asked in the audio. Do NOT answer them.

Rules:
- Go through the frames in order. The same question usually appears in several frames (scrolling, camera shake, text appearing gradually): output it ONCE, using the frame where it is most complete.
- Do not skip a question because it is small, partly scrolled, or in a corner. Missing a question is the worst error.
- "number": the number/label printed on the test ("1", "12", "3a"). If the test prints no numbers, number questions "1", "2", ... in order of appearance. Every "number" must be unique: when the test restarts numbering in a new section, prefix the section ("II.1", "Part 2 - 1").
- "text": copy the question verbatim. Write each blank as "____". Do not correct the test's wording.
- "options": every answer choice with its printed label (A, B, C, ...). Empty array when there are no choices.
- Shared reading passages, dialogues or instructions that several questions depend on go into "passages" (copy the full text); reference them with "passage_id". Use "" when a question has no passage.
- For listening questions, "transcript_excerpt" is the part of the transcript needed to answer (copy the lines with their [mm:ss]). Use "" otherwise.
- "frame_times": the mm:ss labels of the frames that show this question (and its passage).
- "incomplete": true when part of the question or its choices is never fully visible in any frame.
- Never invent questions. UI chrome, titles, scores and instructions are not questions.`;

export function buildFrameBlocks(frames) {
  return frames.flatMap((f) => [
    { type: 'text', text: `Frame at ${formatTime(f.t)}` },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } },
  ]);
}

export function transcriptBlock(transcript) {
  return {
    type: 'text',
    text: transcript ? `Speech transcript of the video:\n${transcript}` : 'The video has no usable speech transcript.',
  };
}

const completeness = (q) => q.text.length + q.options.reduce((n, o) => n + o.text.length + 8, 0) - (q.incomplete ? 1000 : 0);

/** Trong MỘT lô, hai câu trùng `number` là hai câu khác nhau (model quên thêm tiền tố) → đổi tên, không nuốt. */
export function uniquifyNumbers(questions) {
  const seen = new Map();
  return questions.map((q) => {
    const count = (seen.get(q.number) ?? 0) + 1;
    seen.set(q.number, count);
    return count === 1 ? q : { ...q, number: `${q.number} (${count})` };
  });
}

/** Gộp câu hỏi giữa các lô theo `number`; bản đầy đủ hơn thắng. Giữ thứ tự xuất hiện. */
export function mergeQuestions(existing, incoming) {
  const merged = new Map(existing.map((q) => [q.number, q]));
  for (const q of uniquifyNumbers(incoming)) {
    const prev = merged.get(q.number);
    merged.set(q.number, !prev || completeness(q) > completeness(prev) ? q : prev);
  }
  return [...merged.values()];
}

const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * @param {object} p
 * @param {{t: number, data: string}[]} p.frames
 * @param {string} p.transcript
 * @param {{model: string, effort: string}} p.config
 * @param {(req: object) => Promise<{data: any, usage: object}>} p.call
 */
export async function extractQuestions({ frames, transcript, config, call, onBatch = () => {} }) {
  const batches = chunk(frames, FRAME.maxPerRequest);
  let questions = [];
  let passages = [];
  const usages = [];
  for (const [i, batch] of batches.entries()) {
    onBatch({ index: i + 1, total: batches.length });
    const known = questions.length
      ? `\n\nThis is part ${i + 1} of ${batches.length} of the same video. Questions already extracted from earlier parts: ${questions
          .map((q) => `${q.number} ("${q.text.slice(0, 60)}")`)
          .join('; ')}. Output only questions that are new, or that are more complete in these frames (reuse the same "number").`
      : '';
    const { data, usage } = await call({
      ...config,
      system: SYSTEM_PROMPT,
      schema: EXTRACT_SCHEMA,
      content: [...buildFrameBlocks(batch), transcriptBlock(transcript), { type: 'text', text: EXTRACT_INSTRUCTIONS + known }],
    });
    // Passage id chỉ duy nhất trong một lô → thêm tiền tố lô để không đụng nhau.
    const prefix = batches.length > 1 ? `b${i + 1}-` : '';
    passages = [...passages, ...data.passages.map((p) => ({ ...p, id: prefix + p.id }))];
    questions = mergeQuestions(
      questions,
      data.questions.map((q) => ({ ...q, number: q.number.trim(), passage_id: q.passage_id ? prefix + q.passage_id : '' })),
    );
    usages.push(usage);
  }
  const usedPassages = new Set(questions.map((q) => q.passage_id));
  return { questions, passages: passages.filter((p) => usedPassages.has(p.id)), usages };
}
