// Bước C — đối chiếu chéo hai lượt giải và chốt đáp án (logic thuần, không gọi mạng).

/** Chuẩn hoá đáp án để so sánh: "(b) went." ≡ "B", "Went" ≡ "went". */
export function normalizeAnswer(answer, question) {
  const text = String(answer ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s*[/|;]\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,:]+$/, '');
  const options = question?.options ?? [];
  if (!options.length) return text;
  const labels = options.map((o) => o.label.trim().toLowerCase().replace(/[().:]/g, ''));
  const lead = text.match(/^\(?([a-z0-9]{1,2})\)?(?:[.):\s-]|$)/)?.[1];
  if (lead && labels.includes(lead)) return lead;
  const byText = options.findIndex((o) => o.text.trim().toLowerCase().replace(/[.!?,:]+$/, '') === text);
  return byText >= 0 ? labels[byText] : text;
}

export function answersAgree(a, b, question) {
  const na = normalizeAnswer(a?.answer, question);
  return na !== '' && na === normalizeAnswer(b?.answer, question);
}

const byNumber = (answers) => new Map(answers.map((a) => [String(a.number).trim(), a]));

/** Các câu hai lượt giải lệch nhau (kể cả khi một lượt bỏ sót câu). */
export function findDisputes(questions, answersA, answersB) {
  const a = byNumber(answersA);
  const b = byNumber(answersB);
  return questions
    .filter((q) => !answersAgree(a.get(q.number), b.get(q.number), q))
    .map((q) => ({ number: q.number, a: a.get(q.number), b: b.get(q.number) }));
}

const unanswered = (q) => ({ number: q.number, answer: '', explanation: 'Không có đáp án cho câu này.', uncertain: true, source: 'none' });

/** Chế độ Nhanh / khi không đối chiếu được: một lượt giải, (?) khi model tự nhận không chắc. */
export function finalizeSingle(questions, answers) {
  const a = byNumber(answers);
  return questions.map((q) => {
    const ans = a.get(q.number);
    if (!ans || !String(ans.answer).trim()) return unanswered(q);
    return { number: q.number, answer: ans.answer.trim(), explanation: ans.explanation, uncertain: ans.confidence === 'low', source: 'single' };
  });
}

/**
 * Chế độ Chính xác:
 * - hai lượt trùng → chốt ((?) chỉ khi cả hai cùng tự nhận "low");
 * - lệch → theo trọng tài; (?) khi trọng tài "low", hoặc chọn đáp án không trùng lượt nào, hoặc không trả lời.
 */
export function finalizeCrossChecked(questions, answersA, answersB, refereeAnswers) {
  const a = byNumber(answersA);
  const b = byNumber(answersB);
  const r = byNumber(refereeAnswers);
  return questions.map((q) => {
    const qa = a.get(q.number);
    const qb = b.get(q.number);
    if (answersAgree(qa, qb, q)) {
      return {
        number: q.number,
        answer: qa.answer.trim(),
        explanation: qa.explanation,
        uncertain: qa.confidence === 'low' && qb.confidence === 'low',
        source: 'agreed',
      };
    }
    const qr = r.get(q.number);
    if (qr && String(qr.answer).trim()) {
      const matchesASolver = answersAgree(qr, qa, q) || answersAgree(qr, qb, q);
      return {
        number: q.number,
        answer: qr.answer.trim(),
        explanation: qr.explanation,
        uncertain: qr.confidence === 'low' || !matchesASolver,
        source: 'referee',
      };
    }
    const fallback = [qa, qb].find((x) => x && String(x.answer).trim());
    return fallback
      ? { number: q.number, answer: fallback.answer.trim(), explanation: fallback.explanation, uncertain: true, source: 'unresolved' }
      : unanswered(q);
  });
}

/** Trắc nghiệm: "B" / "goes" / "(b)" → "B. goes"; câu điền từ hoặc không khớp lựa chọn nào thì giữ nguyên. */
export function displayAnswer(answer, question) {
  const text = answer || '';
  const label = normalizeAnswer(text, question);
  const option = label && question?.options?.find((o) => o.label.trim().toLowerCase().replace(/[().:]/g, '') === label);
  return option ? `${option.label}. ${option.text}` : text;
}

/** Dòng hiển thị: "1. B. goes", "2. went (?)". */
export function formatAnswerLine(result, question) {
  const answer = displayAnswer(result.answer, question);
  return `${result.number}. ${answer}${result.uncertain ? `${answer ? ' ' : ''}(?)` : ''}`;
}

export function formatAnswerSheet(results, questions = []) {
  const byNum = new Map(questions.map((q) => [q.number, q]));
  return [`Tổng: ${results.length} câu`, ...results.map((r) => formatAnswerLine(r, byNum.get(r.number)))].join('\n');
}
