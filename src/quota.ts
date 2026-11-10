import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type { GenerationStatus } from './contract.ts';

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 주간 토큰 할당량 규칙 (comdraft Next.js 의 lib/generation/quota.ts 와 같은 로직)
 * - 한도와 비율은 코드에 두지 않고 항상 QuotaPlan(comdraft.quota_plan 행)으로 받음
 */

export interface QuotaPlan {
  role: string;
  weeklyTokenLimit: number;
  overrunRatio: number;
  resetTimezone: string;
  resetWeekday: number;
  resetHour: number;
}

export interface QuotaJob {
  status: GenerationStatus;
  estimatedTokens: number | null;
  usedTokens: number;
  errorCode: string | null;
}

/**
 * now 가 속한 할당량 주의 시작과 다음 초기화 시각
 * - 주 시작은 now 이전(포함)의 가장 가까운 resetWeekday 요일 resetHour 시 (resetTimezone 기준)
 * - 서버 시간대와 무관하게 plan 의 시간대로만 계산
 */
export const getQuotaWeek = (
  now: Date,
  plan: QuotaPlan,
): { start: Date; resetsAt: Date } => {
  const local = dayjs(now).tz(plan.resetTimezone);
  const sameDayReset = local.startOf('day').hour(plan.resetHour);
  const daysBack = (local.day() - plan.resetWeekday + 7) % 7;
  let start = sameDayReset.subtract(daysBack, 'day');

  // 초기화 요일 당일이지만 아직 초기화 시각 전이면 지난주로 본다
  if (start.valueOf() > now.getTime()) {
    start = start.subtract(7, 'day');
  }

  return { start: start.toDate(), resetsAt: start.add(7, 'day').toDate() };
};

// 예상 사용량이 남은 양의 허용 비율 이내인지 (남은 양이 0 이하면 항상 거부)
export const isWithinAllowance = (
  estimate: number,
  remaining: number,
  plan: QuotaPlan,
): boolean => remaining > 0 && estimate <= remaining * plan.overrunRatio;

// 작업 하나가 이번 주 사용량에 더하는 토큰 수
export const getJobUsage = (job: QuotaJob): number => {
  if (job.status === 'queued' || job.status === 'running') {
    return Math.max(job.estimatedTokens ?? 0, job.usedTokens);
  }

  if (job.status === 'failed' && job.errorCode === 'quota_exceeded') {
    return 0;
  }

  return job.usedTokens;
};
