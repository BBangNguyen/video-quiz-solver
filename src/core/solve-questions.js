// Bước B — giải câu hỏi; và lượt trọng tài khi hai lượt giải lệch nhau.
import { FRAME } from './constants.js';
import { capFrames } from './frame-dedupe.js';
import { SYSTEM_PROMPT, buildFrameBlocks, transcriptBlock } from './extract-questions.js';

const STRING = { type: 'string' };

export const SOLVE_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: STRING,
          answer: STRING,
          explanation: STRING,
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['number', 'answer', 'explanation', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['answers'],
  additionalProperties: false,
};

const ANSWER_FORMAT = `Answer format:
- "number": exactly the "number" of the question in the JSON.
- "answer": multiple choice → ONLY the letter/label of the correct choice (e.g. "B"). Fill-in-the-blank → only the word(s) that go in the blank; several blanks separated by " / ". True/false → "True" or "False". Other types → the shortest complete answer.
- "explanation": one or two sentences in Vietnamese saying why this answer is right.
- "confidence": "high" when you are sure; "medium" when plausible alternatives exist; "low" when the question is unreadable, incomplete, or you are guessing.`;

const SOLVE_INSTRUCTIONS = `Task: answer every question in the JSON above — one entry per question, same order, none skipped.

- The JSON was transcribed from the frames and can contain reading errors. Check each question against the frames (see its "frame_times") before answering; when they differ, trust the frames.
- For listening questions rely on the transcript, keeping in mind that it may mishear words.
- Work each question out carefully: for grammar, test every choice in the sentence; for reading, find the supporting sentence in the passage.

${ANSWER_FORMAT}`;

const parseTime = (label) => {
  const [m, s] = String(label).split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : null;
};

/** Khung gửi kèm bước giải: tất cả nếu vừa một request, không thì chỉ khung liên quan tới các câu hỏi. */
export function selectSolveFrames(frames, questions, max = FRAME.maxPerRequest) {
  if (frames.length <= max) return frames;
  const times = questions.flatMap((q) => q.frame_times.map(parseTime)).filter((t) => t !== null);
  const relevant = frames.filter((f) => times.some((t) => Math.abs(f.t - t) <= 1.5));
  return capFrames(relevant.length ? relevant : frames, max);
}

function sharedBlocks({ frames, transcript, questions, passages }) {
  return [
    ...buildFrameBlocks(selectSolveFrames(frames, questions)),
    transcriptBlock(transcript),
    { type: 'text', text: `Questions extracted from the video (JSON):\n${JSON.stringify({ passages, questions }, null, 1)}` },
  ];
}

/** @returns {Promise<{answers: object[], usage: object}>} */
export async function solveQuestions({ frames, transcript, questions, passages, config, call }) {
  const { data, usage } = await call({
    ...config,
    system: SYSTEM_PROMPT,
    schema: SOLVE_SCHEMA,
    content: [...sharedBlocks({ frames, transcript, questions, passages }), { type: 'text', text: SOLVE_INSTRUCTIONS }],
  });
  return { answers: data.answers, usage };
}

const describe = (a) => (a ? `"${a.answer}" (confidence ${a.confidence}) — ${a.explanation}` : 'gave no answer');

/**
 * Lượt trọng tài: chỉ xét các câu hai lượt giải lệch nhau.
 * @param {{number: string, a: object|undefined, b: object|undefined}[]} p.disputes
 */
export async function refereeDisputes({ frames, transcript, questions, passages, disputes, config, call }) {
  const disputed = new Set(disputes.map((d) => d.number));
  const disputedQuestions = questions.filter((q) => disputed.has(q.number));
  const list = disputes.map((d) => `Question ${d.number}:\n- Solver 1: ${describe(d.a)}\n- Solver 2: ${describe(d.b)}`).join('\n\n');
  const { data, usage } = await call({
    ...config,
    system: SYSTEM_PROMPT,
    schema: SOLVE_SCHEMA,
    content: [
      ...sharedBlocks({ frames, transcript, questions: disputedQuestions, passages }),
      {
        type: 'text',
        text: `Two independent solvers disagree on the questions below. You are the referee.

${list}

For each of these questions, re-read it in the frames, weigh both arguments on their merits, and decide the correct answer. Either solver — or neither — may be right; do not favour one by default. Output one entry per disputed question and nothing else.

${ANSWER_FORMAT}`,
      },
    ],
  });
  return { answers: data.answers, usage };
}
