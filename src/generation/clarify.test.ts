import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GenerationClarification } from '../contract.ts';
import {
  CLARIFY_OPTION_MAX,
  CLARIFY_QUESTION_MAX,
  CLARIFY_REASON_MAX,
  answeredPairs,
  parseJobClarification,
  validateClarify,
} from './clarify.ts';
import type { RawPlan } from './schemas.ts';

const raw = (
  questions: { question: string; options: string[] }[],
  extra: Partial<RawPlan['clarify']> = {},
): RawPlan['clarify'] => ({ needed: true, reason: '방향이 갈린다', questions, ...extra });

describe('validateClarify', () => {
  it('묻지 않기로 하면 null', () => {
    assert.equal(
      validateClarify({ needed: false, reason: '', questions: [{ question: 'q', options: ['a', 'b'] }] }),
      null,
    );
  });

  it('needed 인데 질문이 없으면 null', () => {
    assert.equal(validateClarify(raw([])), null);
  });

  it('질문 4개째와 보기 4개째는 버린다', () => {
    const out = validateClarify(
      raw([
        { question: 'q1', options: ['a', 'b', 'c', 'd'] },
        { question: 'q2', options: [] },
        { question: 'q3', options: [] },
        { question: 'q4', options: [] },
      ]),
    );
    assert.equal(out?.questions.length, 3);
    assert.deepEqual(out?.questions[0].options, ['a', 'b', 'c']);
  });

  it('빈 문장은 버린다', () => {
    const out = validateClarify(
      raw([
        { question: '   ', options: ['a', 'b'] },
        { question: ' 첫째 ', options: [' a ', '  ', 'b'] },
      ]),
    );
    assert.deepEqual(out?.questions, [{ id: 'Q1', question: '첫째', options: ['a', 'b'] }]);
  });

  it('질문이 모두 비면 null', () => {
    assert.equal(validateClarify(raw([{ question: ' ', options: [] }])), null);
  });

  it('보기가 1개면 직접 입력만 남긴다', () => {
    const out = validateClarify(raw([{ question: 'q', options: ['a'] }]));
    assert.deepEqual(out?.questions[0].options, []);
  });

  it('id 는 남은 질문 순서대로 Q1 부터', () => {
    const out = validateClarify(
      raw([
        { question: '', options: [] },
        { question: 'x', options: [] },
        { question: 'y', options: [] },
      ]),
    );
    assert.deepEqual(
      out?.questions.map((q) => q.id),
      ['Q1', 'Q2'],
    );
  });

  it('긴 문장은 상한까지만', () => {
    const out = validateClarify(
      raw([{ question: 'q'.repeat(300), options: ['o'.repeat(200), 'b'] }], {
        reason: 'r'.repeat(300),
      }),
    );
    assert.equal(out?.reason.length, CLARIFY_REASON_MAX);
    assert.equal(out?.questions[0].question.length, CLARIFY_QUESTION_MAX);
    assert.equal(out?.questions[0].options[0].length, CLARIFY_OPTION_MAX);
  });
});

const stored = (answers: GenerationClarification['answers']): GenerationClarification => ({
  reason: 'r',
  questions: [
    { id: 'Q1', question: 'a?', options: [] },
    { id: 'Q2', question: 'b?', options: ['x', 'y'] },
  ],
  answers,
});

describe('parseJobClarification', () => {
  it('정상 값은 그대로 돌려준다', () => {
    const value = stored([{ id: 'Q1', answer: '네' }]);
    assert.deepEqual(parseJobClarification(value), value);
  });

  it('문자열 JSON 도 읽는다', () => {
    const value = stored(null);
    assert.deepEqual(parseJobClarification(JSON.stringify(value)), value);
  });

  it('형식이 다르면 null', () => {
    assert.equal(parseJobClarification(null), null);
    assert.equal(parseJobClarification('{깨진'), null);
    assert.equal(parseJobClarification({ reason: 'r' }), null);
    assert.equal(parseJobClarification({ ...stored(null), answers: 'done' }), null);
    assert.equal(
      parseJobClarification({ ...stored(null), questions: [{ id: 'Q1', question: 'a', options: [1] }] }),
      null,
    );
  });
});

describe('answeredPairs', () => {
  it('답이 없거나 skipped 면 빈 목록', () => {
    assert.deepEqual(answeredPairs(null), []);
    assert.deepEqual(answeredPairs(stored(null)), []);
    assert.deepEqual(answeredPairs(stored('skipped')), []);
  });

  it('모르는 id 는 빼고 질문 순서대로 짝짓는다', () => {
    assert.deepEqual(
      answeredPairs(
        stored([
          { id: 'Q2', answer: 'y' },
          { id: 'Q9', answer: '?' },
          { id: 'Q1', answer: '네' },
        ]),
      ),
      [
        { id: 'Q1', question: 'a?', answer: '네' },
        { id: 'Q2', question: 'b?', answer: 'y' },
      ],
    );
  });
});
