import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateFillTokens, estimateJobTokens } from './estimate.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_FILL_OUTPUT,
  ESTIMATE_OUTLINE_CODE,
  ESTIMATE_PLAN_OUTPUT,
  ESTIMATE_REVIEW_OUTPUT,
  ESTIMATE_WRITE_OUTPUT,
  HUNK_TOKEN_BUDGET,
} from './limits.ts';

const BASE = { catalogTokens: 5_000, hunkTokens: 10_000, linkTokens: 0, requestTokens: 100 };
const SYSTEM = { plan: 2_000, analyze: 2_500, write: 2_500, review: 0, revise: 0 };

describe('estimateJobTokens', () => {
  it('입력과 길이에 따라 커진다', () => {
    const short = estimateJobTokens(BASE, 'short', SYSTEM);

    assert.ok(estimateJobTokens(BASE, 'medium', SYSTEM) > short);
    assert.ok(estimateJobTokens(BASE, 'long', SYSTEM) > estimateJobTokens(BASE, 'medium', SYSTEM));
    assert.equal(estimateJobTokens({ ...BASE, linkTokens: 9_000 }, 'short', SYSTEM), short + 9_000);
  });

  it('hunk 는 분석 단계 상한까지만 센다', () => {
    assert.equal(
      estimateJobTokens({ ...BASE, hunkTokens: 90_000 }, 'short', SYSTEM),
      estimateJobTokens({ ...BASE, hunkTokens: HUNK_TOKEN_BUDGET }, 'short', SYSTEM),
    );
  });

  it('시스템 + 요청 × 4 + 카탈로그 + hunk + 링크 + 기획 출력 × 2 + 분석 출력 × 4 + 코드 여유분 × 3 + 작성 출력 × 4 + 검토 출력 × 2', () => {
    assert.equal(
      estimateJobTokens({ ...BASE, linkTokens: 1_000 }, 'medium', SYSTEM),
      7_000 + 400 + 5_000 + 10_000 + 1_000 +
        ESTIMATE_PLAN_OUTPUT * 2 + ESTIMATE_ANALYSIS_OUTPUT * 4 + ESTIMATE_OUTLINE_CODE * 3 +
        ESTIMATE_WRITE_OUTPUT.medium * 4 + ESTIMATE_REVIEW_OUTPUT * 2,
    );
    assert.equal(ESTIMATE_PLAN_OUTPUT, 3_000);
    assert.equal(ESTIMATE_ANALYSIS_OUTPUT, 6_000);
    assert.deepEqual(ESTIMATE_WRITE_OUTPUT, { short: 6_000, medium: 9_000, long: 14_000 });
  });
});

describe('estimateJobTokens 검토·고쳐 쓰기', () => {
  it('검토·고쳐 쓰기 입력·출력과 작성 재료의 코드 여유분을 더한다', () => {
    const base = estimateJobTokens(BASE, 'medium', SYSTEM);
    const withReview = estimateJobTokens(BASE, 'medium', { ...SYSTEM, review: 10, revise: 20 });

    assert.equal(withReview - base, 30);
    assert.equal(ESTIMATE_OUTLINE_CODE, 4_000);
    assert.equal(ESTIMATE_REVIEW_OUTPUT, 2_000);

    const oldFormula =
      7_000 + 300 + 5_000 + 10_000 + 0 +
      ESTIMATE_PLAN_OUTPUT * 2 + ESTIMATE_ANALYSIS_OUTPUT * 2 + ESTIMATE_WRITE_OUTPUT.medium;
    assert.equal(
      withReview,
      oldFormula +
        BASE.requestTokens +
        ESTIMATE_ANALYSIS_OUTPUT * 2 +
        ESTIMATE_OUTLINE_CODE * 3 +
        ESTIMATE_WRITE_OUTPUT.medium * 3 +
        ESTIMATE_REVIEW_OUTPUT * 2 +
        10 +
        20,
    );
  });
});

describe('estimateFillTokens', () => {
  it('system + 사용자 입력(본문·재료·질문·답) + 출력 여유분 1,500', () => {
    assert.equal(ESTIMATE_FILL_OUTPUT, 1_500);
    assert.equal(estimateFillTokens({ system: 1_200, user: 3_000 }), 1_200 + 3_000 + 1_500);
  });
});
