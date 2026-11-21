// Pipeline dùng chung cho web và script eval: trích → giải → đối chiếu → chốt.
// Mỗi bước lưu kết quả vào `store` nên chạy lại sẽ tiếp tục từ bước đang dở.
import { MODES } from './constants.js';
import { ClaudeError } from './claude-client.js';
import { extractQuestions } from './extract-questions.js';
import { solveQuestions, refereeDisputes } from './solve-questions.js';
import { findDisputes, finalizeCrossChecked, finalizeSingle } from './cross-check.js';
import { totalCost } from './cost.js';

export function createMemoryStore() {
  const map = new Map();
  return { get: async (key) => map.get(key), set: async (key, value) => void map.set(key, value) };
}

// Lượt đối chiếu hỏng vì lý do không thử lại được → vẫn trả kết quả một lượt thay vì bỏ cả bài.
const DEGRADABLE = new Set(['refusal', 'truncated', 'parse']);

/**
 * @param {object} p
 * @param {{t: number, data: string}[]} p.frames - khung hình JPEG base64 đã lọc trùng
 * @param {string} p.transcript - transcript có [mm:ss], hoặc '' nếu không có tiếng
 * @param {'accurate'|'fast'} p.mode
 * @param {(req: object) => Promise<{data: any, usage: object}>} p.call - callClaude đã gắn fetch + key
 * @param {{get: Function, set: Function}} [p.store]
 * @param {(step: 'extract'|'solve'|'crosscheck', detail?: object) => void} [p.onProgress]
 */
export async function runPipeline({ frames, transcript, mode, call, store = createMemoryStore(), onProgress = () => {} }) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`Chế độ không hợp lệ: ${mode}`);

  const step = async (key, run) => {
    const saved = await store.get(key);
    if (saved) return saved;
    const result = await run();
    await store.set(key, result);
    return result;
  };
  const finish = (extracted, results, usages, notes = []) => ({
    questions: extracted.questions,
    passages: extracted.passages,
    results,
    usages,
    cost: totalCost(usages),
    notes,
  });

  onProgress('extract');
  const extracted = await step('extract', () =>
    extractQuestions({ frames, transcript, config: cfg.extract, call, onBatch: (b) => onProgress('extract', b) }),
  );
  const { questions, passages } = extracted;
  if (!questions.length) return finish(extracted, [], extracted.usages);

  const solveArgs = { frames, transcript, questions, passages, call };
  onProgress('solve');
  if (!cfg.crossCheck) {
    const solved = await step('solveA', () => solveQuestions({ ...solveArgs, config: cfg.solve }));
    return finish(extracted, finalizeSingle(questions, solved.answers), [...extracted.usages, solved.usage]);
  }

  const [primary, secondary] = await Promise.all([
    step('solveA', () => solveQuestions({ ...solveArgs, config: cfg.solve })),
    step('solveB', () =>
      solveQuestions({ ...solveArgs, config: cfg.crossCheck }).catch((e) => {
        if (e instanceof ClaudeError && DEGRADABLE.has(e.kind)) return { answers: null, usage: null, failed: e.message };
        throw e;
      }),
    ),
  ]);
  const usages = [...extracted.usages, primary.usage, secondary.usage];
  if (!secondary.answers) {
    return finish(extracted, finalizeSingle(questions, primary.answers), usages, [
      `Không đối chiếu chéo được (${secondary.failed}) — kết quả chỉ từ một lượt giải.`,
    ]);
  }

  const disputes = findDisputes(questions, primary.answers, secondary.answers);
  onProgress('crosscheck', { disputes: disputes.length });
  const referee = disputes.length
    ? await step('referee', () =>
        refereeDisputes({ ...solveArgs, disputes, config: cfg.referee }).catch((e) => {
          if (e instanceof ClaudeError && DEGRADABLE.has(e.kind)) return { answers: [], usage: null, failed: e.message };
          throw e;
        }),
      )
    : { answers: [], usage: null };
  return finish(
    extracted,
    finalizeCrossChecked(questions, primary.answers, secondary.answers, referee.answers),
    [...usages, referee.usage],
    referee.failed ? [`Lượt trọng tài hỏng (${referee.failed}) — các câu lệch nhau được đánh dấu (?).`] : [],
  );
}
