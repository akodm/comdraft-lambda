import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getJobUsage,
  getQuotaWeek,
  isWithinAllowance,
  type QuotaPlan,
} from './quota.ts';

const seoul: QuotaPlan = {
  role: 'basic',
  weeklyTokenLimit: 100_000,
  overrunRatio: 1.3,
  resetTimezone: 'Asia/Seoul',
  resetWeekday: 0,
  resetHour: 0,
};

describe('getQuotaWeek', () => {
  it('토 23:59:59 KST 는 지난 일요일 주', () => {
    assert.deepEqual(getQuotaWeek(new Date('2026-11-14T14:59:59Z'), seoul), {
      start: new Date('2026-11-07T15:00:00Z'),
      resetsAt: new Date('2026-11-14T15:00:00Z'),
    });
  });

  it('일 00:00 KST 는 그 시각이 주 시작', () => {
    assert.deepEqual(getQuotaWeek(new Date('2026-11-14T15:00:00Z'), seoul), {
      start: new Date('2026-11-14T15:00:00Z'),
      resetsAt: new Date('2026-11-21T15:00:00Z'),
    });
  });

  it('다른 정책: UTC 월요일 9시', () => {
    const plan = {
      ...seoul,
      resetTimezone: 'UTC',
      resetWeekday: 1,
      resetHour: 9,
    };
    assert.deepEqual(
      getQuotaWeek(new Date('2026-11-16T08:59:59Z'), plan).start,
      new Date('2026-11-09T09:00:00Z'),
    );
    assert.deepEqual(
      getQuotaWeek(new Date('2026-11-16T09:00:00Z'), plan).start,
      new Date('2026-11-16T09:00:00Z'),
    );
  });
});

describe('isWithinAllowance', () => {
  it('남은 양의 1.3배까지 허용', () => {
    assert.equal(isWithinAllowance(26_000, 20_000, seoul), true);
    assert.equal(isWithinAllowance(26_001, 20_000, seoul), false);
    assert.equal(isWithinAllowance(1, 0, seoul), false);
    assert.equal(isWithinAllowance(1, -5, seoul), false);
  });
});

describe('getJobUsage', () => {
  it('작업별 사용량 규칙', () => {
    const usage = (
      status: 'queued' | 'running' | 'completed' | 'failed',
      estimatedTokens: number | null,
      usedTokens: number,
      errorCode: string | null,
    ) => getJobUsage({ status, estimatedTokens, usedTokens, errorCode });

    assert.equal(usage('running', 50_000, 12_000, null), 50_000);
    assert.equal(usage('running', 50_000, 61_000, null), 61_000);
    assert.equal(usage('queued', null, 0, null), 0);
    assert.equal(usage('completed', 50_000, 42_000, null), 42_000);
    assert.equal(usage('failed', 90_000, 0, 'quota_exceeded'), 0);
    assert.equal(usage('failed', 50_000, 7_000, 'llm_failed'), 7_000);
  });
});
