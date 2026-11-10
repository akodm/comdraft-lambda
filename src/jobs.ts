import type {
  GenerationErrorCode,
  GenerationStatus,
  GenerationStep,
} from './contract.ts';
import type { Database } from './db.ts';
import {
  getJobUsage,
  getQuotaWeek,
  isWithinAllowance,
  type QuotaPlan,
} from './quota.ts';

/**
 * 작성 작업(comdraft.draft_prompt) 상태 전이
 * - Next.js 의 lib/generation/jobs.ts 와 같은 규칙: 조건부 UPDATE 로만 바꾸고, 이미 끝난 작업은 건드리지 않음
 * - 비동기 호출이 중복돼도 queued → running 은 한 번만 성공하므로 두 번째 실행은 바로 끝남
 */

// 작성 프롬프트와 결과 글의 언어 (draft_prompt.locale, DB 제약으로 두 값만 저장됨)
export type JobLocale = 'ko' | 'en';

// 작업에 필요한 값 (요청 문구, 기본 옵션, 언어, 커밋 SHA, 저장소)
export interface JobContext {
  prompt: string;
  tone: string;
  postType: string;
  length: string;
  requiredBlocks: string[];
  locale: JobLocale;
  // 사용자가 붙인 참고 링크 (등록 순서)
  referenceUrls: string[];
  commitShas: string[];
  owner: string;
  repo: string;
}

export interface JobStore {
  // queued → running (이미 시작했거나 끝난 작업이면 null)
  markRunning: (jobId: string) => Promise<{ channel: string } | null>;
  loadContext: (jobId: string) => Promise<JobContext | null>;
  // 진행 단계 갱신 (running 인 작업만, 그 사이 끝났으면 false)
  markStep: (jobId: string, step: GenerationStep) => Promise<boolean>;
  // 결과 저장 후 완료 (running 인 작업만)
  complete: (jobId: string, result: string) => Promise<boolean>;
  // 실패 처리 (진행 중인 작업만, 사유 코드만 남김)
  fail: (jobId: string, errorCode: GenerationErrorCode) => Promise<boolean>;
  // 예상 사용량을 기록하고 이번 주 남은 양으로 시작할 수 있는지 판정 (사용자별 advisory lock 트랜잭션)
  reserveQuota: (
    jobId: string,
    estimate: number,
    now: Date,
  ) => Promise<QuotaReservation>;
  // 사용한 토큰을 누적 (0 이하는 무시)
  addUsage: (jobId: string, tokens: number) => Promise<void>;
}

// reserved: 시작 가능, exceeded: 남은 양 초과, no_plan: 사용자 등급의 정책 행 없음
export type QuotaReservation = 'reserved' | 'exceeded' | 'no_plan';

// 작업 → 초안 → 사용자 → 정책 조회 결과 (postgres 는 numeric 을 문자열로 돌려줌)
interface PlanRow {
  userId: string;
  role: string;
  weeklyTokenLimit: number;
  overrunRatio: string;
  resetTimezone: string;
  resetWeekday: number;
  resetHour: number;
}

interface UsageRow {
  status: GenerationStatus;
  estimatedTokens: number | null;
  usedTokens: number;
  errorCode: string | null;
}

// jsonb 컬럼 값을 문자열 배열로 (드라이버가 문자열로 주더라도 파싱하고, 형식이 다르면 빈 배열)
const toUrlList = (value: unknown): string[] => {
  let parsed = value;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  return Array.isArray(parsed)
    ? parsed.filter((url): url is string => typeof url === 'string')
    : [];
};

export const createJobStore = (sql: Database): JobStore => ({
  markRunning: async (jobId) => {
    const [row] = await sql<{ channel: string }[]>`
      update comdraft.draft_prompt
      set status = 'running', started_at = now()
      where id = ${jobId} and status = 'queued'
      returning channel
    `;

    return row ?? null;
  },

  loadContext: async (jobId) => {
    const [row] = await sql<JobContext[]>`
      select p.prompt, p.tone, p.post_type as "postType", p.length,
        p.required_blocks as "requiredBlocks", p.locale, p.commit_shas as "commitShas",
        p.reference_urls as "referenceUrls",
        r.owner_login as owner, r.name as repo
      from comdraft.draft_prompt p
      join comdraft.draft d on d.id = p.draft_id
      join comdraft.github_repository r on r.id = d.repository_id
      where p.id = ${jobId}
      limit 1
    `;

    return row ? { ...row, referenceUrls: toUrlList(row.referenceUrls) } : null;
  },

  markStep: async (jobId, step) => {
    const rows = await sql`
      update comdraft.draft_prompt
      set step = ${step}
      where id = ${jobId} and status = 'running'
      returning id
    `;

    return rows.length > 0;
  },

  complete: async (jobId, result) => {
    const rows = await sql`
      update comdraft.draft_prompt
      set status = 'completed', step = 3, result = ${result}, finished_at = now()
      where id = ${jobId} and status = 'running'
      returning id
    `;

    return rows.length > 0;
  },

  fail: async (jobId, errorCode) => {
    const rows = await sql`
      update comdraft.draft_prompt
      set status = 'failed', error_code = ${errorCode}, finished_at = now()
      where id = ${jobId} and status in ('queued', 'running')
      returning id
    `;

    return rows.length > 0;
  },

  reserveQuota: async (jobId, estimate, now) =>
    sql.begin(async (tx) => {
      // 같은 사용자의 동시 요청이 검사와 기록 사이에 끼어들지 않도록 사용자 id 로 잠금 (트랜잭션이 끝나면 해제)
      const [owner] = await tx<{ userId: string }[]>`
        select d.user_id as "userId"
        from comdraft.draft_prompt p
        join comdraft.draft d on d.id = p.draft_id
        where p.id = ${jobId}
      `;

      if (!owner) {
        return 'no_plan';
      }

      await tx`select pg_advisory_xact_lock(hashtext(${owner.userId}))`;

      const [row] = await tx<PlanRow[]>`
        select d.user_id as "userId", q.role,
          q.weekly_token_limit as "weeklyTokenLimit",
          q.overrun_ratio as "overrunRatio",
          q.reset_timezone as "resetTimezone",
          q.reset_weekday as "resetWeekday",
          q.reset_hour as "resetHour"
        from comdraft.draft_prompt p
        join comdraft.draft d on d.id = p.draft_id
        join comdraft."user" u on u.id = d.user_id
        join comdraft.quota_plan q on q.role = u.role
        where p.id = ${jobId}
      `;

      if (!row) {
        return 'no_plan';
      }

      const plan: QuotaPlan = {
        role: row.role,
        weeklyTokenLimit: Number(row.weeklyTokenLimit),
        overrunRatio: Number(row.overrunRatio),
        resetTimezone: row.resetTimezone,
        resetWeekday: Number(row.resetWeekday),
        resetHour: Number(row.resetHour),
      };
      const week = getQuotaWeek(now, plan);

      // 이번 주 이 사용자의 다른 작업 사용량 (이 작업은 제외)
      const others = await tx<UsageRow[]>`
        select p.status, p.estimated_tokens as "estimatedTokens",
          p.used_tokens as "usedTokens", p.error_code as "errorCode"
        from comdraft.draft_prompt p
        join comdraft.draft d on d.id = p.draft_id
        where d.user_id = ${row.userId}
          and p.created_at >= ${week.start}
          and p.id <> ${jobId}
      `;
      const used = others.reduce((sum, job) => sum + getJobUsage(job), 0);
      const remaining = plan.weeklyTokenLimit - used;

      // 허용 여부와 상관없이 예상량은 남김 (거부된 작업은 getJobUsage 가 0 으로 셈)
      await tx`
        update comdraft.draft_prompt
        set estimated_tokens = ${estimate}
        where id = ${jobId}
      `;

      return isWithinAllowance(estimate, remaining, plan)
        ? 'reserved'
        : 'exceeded';
    }),

  addUsage: async (jobId, tokens) => {
    if (tokens <= 0) {
      return;
    }

    // 단일 UPDATE 라 트랜잭션 없이 원자적으로 누적
    await sql`
      update comdraft.draft_prompt
      set used_tokens = used_tokens + ${tokens}
      where id = ${jobId}
    `;
  },
});
