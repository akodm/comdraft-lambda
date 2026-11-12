import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Length } from '../prompts/types.ts';
import { estimateFillCost, estimateJobCost, estimateStages } from './estimate.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_FILL_OUTPUT,
  ESTIMATE_PLAN_OUTPUT,
  ESTIMATE_WRITE_OUTPUT,
  HUNK_TOKEN_BUDGET,
} from './limits.ts';
import { usageCost } from './models.ts';

const BASE = { catalogTokens: 5_000, hunkTokens: 10_000, linkTokens: 0, requestTokens: 100 };
const SYSTEM = { plan: 2_000, analyze: 2_500, write: 2_500 };

// 단계 분리 전의 예상량 공식 (세 단계 input + output 의 합이 이 값과 같아야 한다)
const oldTotal = (prepared: typeof BASE, length: Length, system: typeof SYSTEM) =>
  system.plan +
  system.analyze +
  system.write +
  prepared.requestTokens * 3 +
  prepared.catalogTokens +
  Math.min(prepared.hunkTokens, HUNK_TOKEN_BUDGET) +
  prepared.linkTokens +
  ESTIMATE_PLAN_OUTPUT * 2 +
  ESTIMATE_ANALYSIS_OUTPUT * 2 +
  ESTIMATE_WRITE_OUTPUT[length];

const sumStages = (stages: ReturnType<typeof estimateStages>) =>
  Object.values(stages).reduce((total, { input, output }) => total + input + output, 0);

describe('estimateStages', () => {
  it('단계 분리 합이 기존 예상량과 같다', () => {
    for (const length of ['short', 'medium', 'long'] as const) {
      for (const hunkTokens of [10_000, 90_000]) {
        const prepared = { ...BASE, hunkTokens, linkTokens: 1_000 };

        assert.equal(sumStages(estimateStages(prepared, length, SYSTEM)), oldTotal(prepared, length, SYSTEM));
      }
    }
  });

  it('단계별 입력·출력', () => {
    const prepared = { ...BASE, linkTokens: 1_000 };

    assert.deepEqual(estimateStages(prepared, 'medium', SYSTEM), {
      plan: { input: 2_000 + 100 + 5_000 + 1_000, output: ESTIMATE_PLAN_OUTPUT },
      analyze: { input: 2_500 + 100 + ESTIMATE_PLAN_OUTPUT + 10_000, output: ESTIMATE_ANALYSIS_OUTPUT },
      write: { input: 2_500 + 100 + ESTIMATE_ANALYSIS_OUTPUT, output: ESTIMATE_WRITE_OUTPUT.medium },
    });
    assert.equal(ESTIMATE_PLAN_OUTPUT, 3_000);
    assert.equal(ESTIMATE_ANALYSIS_OUTPUT, 6_000);
    assert.deepEqual(ESTIMATE_WRITE_OUTPUT, { short: 6_000, medium: 9_000, long: 14_000 });
  });

  it('hunk 는 분석 단계 상한까지만 센다', () => {
    assert.deepEqual(
      estimateStages({ ...BASE, hunkTokens: 90_000 }, 'short', SYSTEM),
      estimateStages({ ...BASE, hunkTokens: HUNK_TOKEN_BUDGET }, 'short', SYSTEM),
    );
  });

  it('글 길이는 작성 출력만 바꾼다', () => {
    const short = estimateStages(BASE, 'short', SYSTEM);
    const long = estimateStages(BASE, 'long', SYSTEM);

    assert.deepEqual(long.plan, short.plan);
    assert.deepEqual(long.analyze, short.analyze);
    assert.equal(long.write.output - short.write.output, ESTIMATE_WRITE_OUTPUT.long - ESTIMATE_WRITE_OUTPUT.short);
  });

  it('검토·고쳐 쓰기 system 프롬프트 크기는 예상량을 바꾸지 않는다', () => {
    const base = estimateStages(BASE, 'medium', SYSTEM);
    const withReview = estimateStages(BASE, 'medium', { ...SYSTEM, review: 10_000, revise: 20_000 } as typeof SYSTEM);

    assert.deepEqual(withReview, base);
  });
});

describe('estimateJobCost', () => {
  const stages = estimateStages(BASE, 'medium', SYSTEM);
  const cost = (model: 'haiku' | 'sonnet' | 'opus') => estimateJobCost(stages, model);
  const priced = (model: 'haiku' | 'sonnet' | 'opus', { input, output }: { input: number; output: number }) =>
    usageCost(model, { input, output, cacheWrite: 0, cacheRead: 0 });

  it('haiku 는 모든 단계를 haiku 단가로 센다', () => {
    assert.equal(
      cost('haiku'),
      priced('haiku', stages.plan) + priced('haiku', stages.analyze) + priced('haiku', stages.write),
    );
  });

  it('opus 예상량은 분석을 haiku 단가로 센다', () => {
    assert.equal(
      cost('opus'),
      priced('opus', stages.plan) + priced('haiku', stages.analyze) + priced('opus', stages.write),
    );
    assert.equal(
      cost('sonnet'),
      priced('sonnet', stages.plan) + priced('haiku', stages.analyze) + priced('sonnet', stages.write),
    );
  });

  it('haiku 예상량 < sonnet < opus', () => {
    assert.ok(cost('haiku') > 0);
    assert.ok(cost('haiku') < cost('sonnet'));
    assert.ok(cost('sonnet') < cost('opus'));
  });
});

describe('estimateFillCost', () => {
  const prompt = { system: 1_200, user: 3_000 };

  it('입력 system + 사용자 입력(본문·재료·질문·답), 출력 여유분 1,500 을 작업 모델 단가로 센다', () => {
    assert.equal(ESTIMATE_FILL_OUTPUT, 1_500);
    assert.equal(
      estimateFillCost(prompt, 'haiku'),
      usageCost('haiku', { input: 4_200, output: 1_500, cacheWrite: 0, cacheRead: 0 }),
    );
    assert.equal(
      estimateFillCost(prompt, 'opus'),
      usageCost('opus', { input: 4_200, output: 1_500, cacheWrite: 0, cacheRead: 0 }),
    );
  });

  it('haiku < sonnet < opus', () => {
    assert.ok(estimateFillCost(prompt, 'haiku') < estimateFillCost(prompt, 'sonnet'));
    assert.ok(estimateFillCost(prompt, 'sonnet') < estimateFillCost(prompt, 'opus'));
  });
});
