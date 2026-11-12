import type {
  GenerationClarification,
  GenerationErrorCode,
  GenerationJobKind,
  GenerationStatus,
  GenerationStep,
} from './contract.ts';
import type { Database } from './db.ts';
import { parseJobClarification } from './generation/clarify.ts';
import type { ClarifyRequest } from './generation/schemas.ts';
import {
  parseStoredAnalysis,
  type StoredAnalysis,
} from './generation/stored-analysis.ts';
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

// 빈칸 채우기 작업의 대상 빈칸 (Next.js 가 요청 시점에 저장한 값)
export interface JobBlank {
  id: string;
  // 빈칸 질문 (hint, 비었으면 종류의 기본 질문)
  question: string;
  // 글쓴이 답
  answer: string;
  // 지금 본문 Markdown (대상 빈칸 자리는 {{target}} 표시, 목록·인용 안이면 줄 앞에 `- `·`> ` 가 붙음.
  // 다른 빈칸은 [빈칸: 질문] 한 줄)
  context: string;
}

// 작업에 필요한 값 (종류, 요청 문구, 기본 옵션, 언어, 커밋 SHA, 저장소, 빈칸 채우기 대상)
export interface JobContext {
  kind: GenerationJobKind;
  // 빈칸 채우기 작업이면 글쓴이 답
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
  // kind 가 'fill' 이고 빈칸 값이 모두 있을 때만
  blank?: JobBlank;
  // 작성 전 되묻기 (null 이면 아직 묻지 않은 작업)
  clarification: GenerationClarification | null;
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
  // 예상 사용량을 기록하고 작업이 만들어진 주의 남은 양으로 시작할 수 있는지 판정 (사용자별 advisory lock 트랜잭션)
  reserveQuota: (jobId: string, estimate: number) => Promise<QuotaReservation>;
  // 사용한 토큰을 누적 (0 이하는 무시)
  addUsage: (jobId: string, tokens: number) => Promise<void>;
  // 초안 작성 작업의 분석 결과 저장 (running 인 작업만)
  saveAnalysis: (jobId: string, analysis: StoredAnalysis) => Promise<void>;
  // 이 작업과 같은 초안의 가장 최근 완료된 초안 작성 작업이 저장한 분석 (없거나 저장하지 않았으면 null)
  loadLatestAnalysis: (jobId: string) => Promise<StoredAnalysis | null>;
  // 작성 전 되묻기: 질문을 저장하고 답변 대기로 멈춘다 (running 이고 아직 묻지 않은 작업만, 단계는 그대로, 예상량은 비움)
  // 그 사이 끝났거나 이미 물었으면 false
  pauseForInput: (jobId: string, request: ClarifyRequest) => Promise<boolean>;
}

// reserved: 시작 가능, exceeded: 남은 양 초과, no_plan: 사용자 등급의 정책 행 없음
export type QuotaReservation = 'reserved' | 'exceeded' | 'no_plan';

// 작업 → 사용자 → 정책 조회 결과 (postgres 는 numeric 을 문자열로 돌려줌)
interface PlanRow {
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

// loadContext 조회 행 (빈칸 값은 빈칸 채우기 작업에만 있음)
interface ContextRow extends Omit<JobContext, 'kind' | 'blank' | 'clarification'> {
  kind: string;
  clarification: unknown;
  blankId: string | null;
  blankQuestion: string | null;
  blankAnswer: string | null;
  blankContext: string | null;
}

// 빈칸 채우기 대상 (id 나 본문이 없으면 다룰 수 없으므로 undefined, 답이 비면 prompt 의 답을 씀)
const toBlank = (row: ContextRow): JobBlank | undefined =>
  row.blankId && row.blankContext
    ? {
        id: row.blankId,
        question: row.blankQuestion ?? '',
        answer: row.blankAnswer ?? row.prompt,
        context: row.blankContext,
      }
    : undefined;

const toContext = (row: ContextRow): JobContext => {
  const { blankId, blankQuestion, blankAnswer, blankContext, clarification, ...rest } = row;
  const kind: GenerationJobKind = row.kind === 'fill' ? 'fill' : 'draft';

  return {
    ...rest,
    kind,
    referenceUrls: toUrlList(row.referenceUrls),
    ...(kind === 'fill' ? { blank: toBlank(row) } : {}),
    clarification: kind === 'draft' ? parseJobClarification(clarification) : null,
  };
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
    const [row] = await sql<ContextRow[]>`
      select p.kind, p.prompt, p.tone, p.post_type as "postType", p.length,
        p.required_blocks as "requiredBlocks", p.locale, p.commit_shas as "commitShas",
        p.reference_urls as "referenceUrls",
        p.blank_id as "blankId", p.blank_question as "blankQuestion",
        p.blank_answer as "blankAnswer", p.blank_context as "blankContext",
        p.clarification,
        r.owner_login as owner, r.name as repo
      from comdraft.draft_prompt p
      join comdraft.draft d on d.id = p.draft_id
      join comdraft.github_repository r on r.id = d.repository_id
      where p.id = ${jobId}
      limit 1
    `;

    return row ? toContext(row) : null;
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

  reserveQuota: async (jobId, estimate) =>
    sql.begin(async (tx) => {
      // 작업의 사용자와 생성 시각 (사용량은 작업 행의 user_id 로 셈, 초안을 삭제해도 작업 행은 남음)
      // → user_id 가 없는 행은 마이그레이션 0015 적용 후 배포 전까지 이전 Next.js 코드가 만든 작업뿐이라 초안의 사용자로 대신함
      //   (초안까지 없으면 사용자를 알 수 없으므로 no_plan)
      const [owner] = await tx<{ userId: string | null; createdAt: Date }[]>`
        select coalesce(p.user_id, d.user_id) as "userId", p.created_at as "createdAt"
        from comdraft.draft_prompt p
        left join comdraft.draft d on d.id = p.draft_id
        where p.id = ${jobId}
      `;

      if (!owner?.userId) {
        return 'no_plan';
      }

      // 같은 사용자의 동시 요청이 검사와 기록 사이에 끼어들지 않도록 사용자 id 로 잠금 (트랜잭션이 끝나면 해제)
      await tx`select pg_advisory_xact_lock(hashtext(${owner.userId}))`;

      const [row] = await tx<PlanRow[]>`
        select q.role,
          q.weekly_token_limit as "weeklyTokenLimit",
          q.overrun_ratio as "overrunRatio",
          q.reset_timezone as "resetTimezone",
          q.reset_weekday as "resetWeekday",
          q.reset_hour as "resetHour"
        from comdraft."user" u
        join comdraft.quota_plan q on q.role = u.role
        where u.id = ${owner.userId}
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
      // 작업은 실행 시각이 아니라 만들어진 시각이 속한 주에 들어감 (주 경계 직전에 요청하고 직후에 실행돼도 같은 주)
      const week = getQuotaWeek(owner.createdAt, plan);

      // 그 주에 이 사용자가 만든 다른 작업 사용량 (이 작업은 제외)
      const others = await tx<UsageRow[]>`
        select p.status, p.estimated_tokens as "estimatedTokens",
          p.used_tokens as "usedTokens", p.error_code as "errorCode"
        from comdraft.draft_prompt p
        where p.user_id = ${owner.userId}
          and p.created_at >= ${week.start}
          and p.created_at < ${week.resetsAt}
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

  saveAnalysis: async (jobId, analysis) => {
    await sql`
      update comdraft.draft_prompt
      set analysis = ${sql.json(analysis)}
      where id = ${jobId} and status = 'running'
    `;
  },

  loadLatestAnalysis: async (jobId) => {
    // 가장 최근 완료 작업이 분석을 저장하지 않았으면(배포 전 작업 등) 더 오래된 작업으로 내려가지 않는다
    // → 지금 본문과 맞지 않는 옛 분석을 쓰지 않기 위해서다
    const [row] = await sql<{ analysis: unknown }[]>`
      select d.analysis
      from comdraft.draft_prompt p
      join comdraft.draft_prompt d on d.draft_id = p.draft_id
      where p.id = ${jobId}
        and d.kind = 'draft'
        and d.status = 'completed'
      order by d.created_at desc
      limit 1
    `;

    return row ? parseStoredAnalysis(row.analysis) : null;
  },

  pauseForInput: async (jobId, { reason, questions }) => {
    // 인터페이스 타입은 JSON 값으로 바로 넘길 수 없어 필드만 뽑아 새 객체로 만든다
    const stored = {
      reason,
      questions: questions.map(({ id, question, options }) => ({ id, question, options })),
      answers: null,
    };
    const rows = await sql`
      update comdraft.draft_prompt
      set status = 'awaiting_input',
        clarification = ${sql.json(stored)},
        estimated_tokens = null
      where id = ${jobId} and status = 'running' and clarification is null
      returning id
    `;

    return rows.length > 0;
  },
});
