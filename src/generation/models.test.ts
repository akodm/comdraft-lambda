import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HAIKU_LONG_PROMPT_TOKENS, stagePlan, toModel, usageCost } from './models.ts';
import type { Stage } from './models.ts';

const STAGES: Stage[] = ['plan', 'analyze', 'write', 'review', 'revise', 'fill'];
const HAIKU_EFFORT = {
  plan: 'medium',
  analyze: 'medium',
  write: 'high',
  review: 'medium',
  revise: 'high',
  fill: 'medium',
} as const;
const HIGHER_EFFORT = {
  plan: 'low',
  analyze: 'medium',
  write: 'medium',
  review: 'low',
  revise: 'medium',
  fill: 'low',
} as const;

describe('stagePlan', () => {
  it('분석은 어떤 모델을 골라도 haiku medium', () => {
    for (const selected of ['haiku', 'sonnet', 'opus'] as const) {
      assert.deepEqual(stagePlan(selected, 'analyze'), {
        model: 'haiku',
        effort: 'medium',
        fallback: null,
      });
    }
  });

  it('haiku 는 단계마다 정해진 사고 깊이를 쓴다', () => {
    for (const stage of STAGES) {
      assert.deepEqual(stagePlan('haiku', stage), {
        model: 'haiku',
        effort: HAIKU_EFFORT[stage],
        fallback: null,
      });
    }
  });

  it('sonnet·opus 는 단계마다 haiku 보다 한 단계 낮다', () => {
    for (const selected of ['sonnet', 'opus'] as const) {
      for (const stage of STAGES.filter((s) => s !== 'analyze')) {
        const call = stagePlan(selected, stage);
        assert.equal(call.model, selected);
        assert.equal(call.effort, HIGHER_EFFORT[stage]);
        assert.notEqual(call.effort, HAIKU_EFFORT[stage]);
      }
    }
  });

  it('haiku 를 고르면 거절 재시도가 없다', () => {
    for (const stage of STAGES) {
      assert.equal(stagePlan('haiku', stage).fallback, null);
    }
  });

  it('sonnet 작성 단계의 재시도는 haiku high', () => {
    assert.deepEqual(stagePlan('sonnet', 'write').fallback, { model: 'haiku', effort: 'high' });
  });

  it('재시도는 그 단계의 haiku 사고 깊이를 쓴다', () => {
    for (const stage of STAGES.filter((s) => s !== 'analyze')) {
      assert.deepEqual(stagePlan('opus', stage).fallback, {
        model: 'haiku',
        effort: HAIKU_EFFORT[stage],
      });
    }
  });
});

describe('usageCost', () => {
  const NONE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

  it('haiku 입력 1,000 + 출력 1,000 은 600 마이크로달러', () => {
    assert.equal(usageCost('haiku', { ...NONE, input: 1_000, output: 1_000 }), 600);
  });

  it('opus 같은 양은 24,000 마이크로달러', () => {
    assert.equal(usageCost('opus', { ...NONE, input: 1_000, output: 1_000 }), 24_000);
  });

  it('sonnet 도 단가대로 센다', () => {
    assert.equal(usageCost('sonnet', { ...NONE, input: 1_000, output: 1_000 }), 12_000);
  });

  it('캐시 쓰기와 읽기를 함께 센다', () => {
    // haiku: 1,000 × 0.125 + 1,000 × 0.01 = 135
    assert.equal(usageCost('haiku', { ...NONE, cacheWrite: 1_000, cacheRead: 1_000 }), 135);
    // opus: 1,000 × 5 + 1,000 × 0.2 = 5,200
    assert.equal(usageCost('opus', { ...NONE, cacheWrite: 1_000, cacheRead: 1_000 }), 5_200);
  });

  it('프롬프트 100,000 은 기본 구간이다', () => {
    assert.equal(HAIKU_LONG_PROMPT_TOKENS, 100_000);
    // 입력 60,000 + 캐시 읽기 40,000 = 100,000: 6,000 + 400
    assert.equal(usageCost('haiku', { ...NONE, input: 60_000, cacheRead: 40_000 }), 6_400);
  });

  it('프롬프트 100,001 은 long 구간이라 모든 토큰이 비싸다', () => {
    // 입력 60,000 + 캐시 읽기 40,001: 30,000 + 2,000.05 → 올림
    assert.equal(usageCost('haiku', { ...NONE, input: 60_000, cacheRead: 40_001 }), 32_001);
    // 출력도 long 단가 (2.5)
    assert.equal(
      usageCost('haiku', { ...NONE, input: 100_001, output: 1_000 }),
      50_001 + 2_500,
    );
  });

  it('sonnet·opus 는 프롬프트가 길어도 단가가 같다', () => {
    assert.equal(usageCost('sonnet', { ...NONE, input: 200_000 }), 400_000);
  });

  it('소수점은 올린다', () => {
    assert.equal(usageCost('haiku', { ...NONE, input: 1 }), 1);
    assert.equal(usageCost('haiku', { ...NONE, cacheRead: 1 }), 1);
    assert.equal(usageCost('haiku', NONE), 0);
  });
});

describe('toModel', () => {
  it('모르는 값과 undefined 는 haiku', () => {
    assert.equal(toModel(undefined), 'haiku');
    assert.equal(toModel(null), 'haiku');
    assert.equal(toModel('gpt'), 'haiku');
    assert.equal(toModel(1), 'haiku');
  });

  it('목록에 있는 값은 그대로 돌려준다', () => {
    assert.equal(toModel('sonnet'), 'sonnet');
    assert.equal(toModel('opus'), 'opus');
    assert.equal(toModel('haiku'), 'haiku');
  });
});
