import test from 'node:test';
import assert from 'node:assert/strict';
import { answersAgree, findDisputes, finalizeCrossChecked, finalizeSingle, formatAnswerSheet, normalizeAnswer } from '../../src/core/cross-check.js';

const mcq = (number) => ({
  number,
  type: 'multiple_choice',
  text: `Q${number}`,
  options: [
    { label: 'A', text: 'go' },
    { label: 'B', text: 'went' },
    { label: 'C', text: 'gone' },
  ],
});
const fill = (number) => ({ number, type: 'fill_blank', text: `She ____ home. (${number})`, options: [] });
const ans = (number, answer, confidence = 'high') => ({ number, answer, confidence, explanation: `vì ${answer}` });

test('normalizeAnswer: chữ cái trắc nghiệm ở nhiều dạng viết', () => {
  for (const raw of ['B', 'b', '(B)', 'B.', 'B) went', 'B. went', 'went', 'Went.']) {
    assert.equal(normalizeAnswer(raw, mcq('1')), 'b', raw);
  }
  assert.equal(normalizeAnswer('D', mcq('1')), 'd', 'nhãn không có trong lựa chọn thì giữ nguyên');
});

test('normalizeAnswer: điền từ — hoa thường, dấu câu, khoảng trắng, nhiều chỗ trống', () => {
  assert.equal(normalizeAnswer('  Went. ', fill('1')), 'went');
  assert.equal(normalizeAnswer("Don’t", fill('1')), "don't");
  assert.equal(normalizeAnswer('has/been', fill('1')), normalizeAnswer('has / been', fill('1')));
  assert.equal(normalizeAnswer(undefined, fill('1')), '');
});

test('answersAgree: hai đáp án rỗng không tính là trùng', () => {
  assert.equal(answersAgree(ans('1', 'B'), ans('1', '(b) went'), mcq('1')), true);
  assert.equal(answersAgree(ans('1', ''), ans('1', ''), fill('1')), false);
  assert.equal(answersAgree(ans('1', 'B'), undefined, mcq('1')), false);
});

test('findDisputes: chỉ trả các câu lệch nhau hoặc bị một lượt bỏ sót', () => {
  const questions = [mcq('1'), mcq('2'), fill('3')];
  const disputes = findDisputes(questions, [ans('1', 'B'), ans('2', 'A'), ans('3', 'went')], [ans('1', 'b'), ans('2', 'C')]);
  assert.deepEqual(disputes.map((d) => d.number), ['2', '3']);
  assert.equal(disputes[0].a.answer, 'A');
  assert.equal(disputes[0].b.answer, 'C');
  assert.equal(disputes[1].b, undefined);
});

test('finalizeCrossChecked: trùng → chốt; lệch → theo trọng tài', () => {
  const questions = [mcq('1'), mcq('2'), mcq('3'), mcq('4'), mcq('5'), fill('6')];
  const a = [ans('1', 'B'), ans('2', 'A'), ans('3', 'A'), ans('4', 'A'), ans('5', 'B', 'low')];
  const b = [ans('1', 'B'), ans('2', 'C'), ans('3', 'C'), ans('4', 'C'), ans('5', 'B', 'low')];
  const referee = [ans('2', 'C'), ans('3', 'B'), ans('4', 'A', 'low')];
  const out = finalizeCrossChecked(questions, a, b, referee);
  assert.deepEqual(
    out.map((r) => [r.number, r.answer, r.uncertain, r.source]),
    [
      ['1', 'B', false, 'agreed'],
      ['2', 'C', false, 'referee'], // trọng tài chọn theo lượt 2, tự tin
      ['3', 'B', true, 'referee'], // trọng tài chọn đáp án không trùng lượt nào → (?)
      ['4', 'A', true, 'referee'], // trọng tài tự nhận low → (?)
      ['5', 'B', true, 'agreed'], // trùng nhưng cả hai đều low → (?)
      ['6', '', true, 'none'], // không lượt nào trả lời
    ],
  );
});

test('finalizeCrossChecked: lệch mà trọng tài không trả lời → lấy lượt chính, đánh dấu (?)', () => {
  const out = finalizeCrossChecked([mcq('1')], [ans('1', 'A')], [ans('1', 'C')], []);
  assert.deepEqual([out[0].answer, out[0].uncertain, out[0].source], ['A', true, 'unresolved']);
});

test('finalizeSingle (chế độ Nhanh): (?) khi confidence low hoặc thiếu đáp án', () => {
  const out = finalizeSingle([mcq('1'), mcq('2'), mcq('3')], [ans('1', 'B'), ans('2', 'C', 'low')]);
  assert.deepEqual(out.map((r) => [r.answer, r.uncertain]), [['B', false], ['C', true], ['', true]]);
});

test('formatAnswerSheet: dòng đầu là tổng số câu, trắc nghiệm kèm nội dung lựa chọn sau chữ cái', () => {
  const sheet = formatAnswerSheet(
    [
      { number: '1', answer: 'B', uncertain: false },
      { number: '2', answer: 'went', uncertain: true },
      { number: '3', answer: '', uncertain: true },
      { number: '4', answer: 'gone', uncertain: false },
      { number: '5', answer: 'D', uncertain: false },
    ],
    [mcq('1'), fill('2'), mcq('3'), mcq('4'), mcq('5')],
  );
  assert.equal(sheet, 'Tổng: 5 câu\n1. B. went\n2. went (?)\n3. (?)\n4. C. gone\n5. D');
});
