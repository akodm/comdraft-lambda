import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { estimateJobTokens } from './estimate.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_PLAN_OUTPUT,
  ESTIMATE_WRITE_OUTPUT,
  HUNK_TOKEN_BUDGET,
} from './limits.ts';

const BASE = { catalogTokens: 5_000, hunkTokens: 10_000, linkTokens: 0, requestTokens: 100 };
const SYSTEM = { plan: 2_000, analyze: 2_500, write: 2_500 };

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

  it('시스템 + 요청 × 3 + 카탈로그 + hunk + 링크 + 기획·분석 출력 × 2 + 작성 출력', () => {
    assert.equal(
      estimateJobTokens({ ...BASE, linkTokens: 1_000 }, 'medium', SYSTEM),
      7_000 + 300 + 5_000 + 10_000 + 1_000 +
        ESTIMATE_PLAN_OUTPUT * 2 + ESTIMATE_ANALYSIS_OUTPUT * 2 + ESTIMATE_WRITE_OUTPUT.medium,
    );
    assert.equal(ESTIMATE_PLAN_OUTPUT, 3_000);
    assert.equal(ESTIMATE_ANALYSIS_OUTPUT, 6_000);
    assert.deepEqual(ESTIMATE_WRITE_OUTPUT, { short: 6_000, medium: 9_000, long: 14_000 });
  });
});
