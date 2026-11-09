import type {
  GenerationErrorCode,
  GenerationStep,
} from './contract.ts';
import type { Database } from './db.ts';

/**
 * 작성 작업(comdraft.draft_prompt) 상태 전이
 * - Next.js 의 lib/generation/jobs.ts 와 같은 규칙: 조건부 UPDATE 로만 바꾸고, 이미 끝난 작업은 건드리지 않음
 * - 비동기 호출이 중복돼도 queued → running 은 한 번만 성공하므로 두 번째 실행은 바로 끝남
 */

// 작업에 필요한 값 (요청 문구, 기본 옵션, 커밋 SHA, 저장소)
export interface JobContext {
  prompt: string;
  tone: string;
  postType: string;
  length: string;
  requiredBlocks: string[];
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
}

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
        p.required_blocks as "requiredBlocks", p.commit_shas as "commitShas",
        r.owner_login as owner, r.name as repo
      from comdraft.draft_prompt p
      join comdraft.draft d on d.id = p.draft_id
      join comdraft.github_repository r on r.id = d.repository_id
      where p.id = ${jobId}
      limit 1
    `;

    return row ?? null;
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
});
