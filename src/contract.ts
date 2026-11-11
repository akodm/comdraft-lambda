/**
 * AI 초안 작성 작업 계약 (comdraft Next.js 의 lib/generation/contract.ts 와 같게 유지)
 * - 요청 형식, Broadcast 이벤트, 오류 코드, 시간 제한이 바뀌면 양쪽을 함께 수정
 */

// 작업 상태 (draft_prompt.status)
export type GenerationStatus = 'queued' | 'running' | 'completed' | 'failed';

// 완료한 단계 (0: 시작 전, 1: 구분, 2: 분석, 3: 작성)
// 빈칸 채우기 작업은 중간 단계 없이 0 에서 완료(3)로 바로 넘어감
export type GenerationStep = 0 | 1 | 2 | 3;

// 작업 종류 (draft_prompt.kind): 초안 작성 / 빈칸 채우기
export type GenerationJobKind = 'draft' | 'fill';

// 빈칸 채우기 본문 스냅숏(draft_prompt.blank_context)에서 채울 자리를 가리키는 한 줄
// (comdraft lib/generation/blank-fill.ts 의 FILL_TARGET_MARKER 와 같은 값)
export const FILL_TARGET_MARKER = '{{target}}';

// API Gateway → Lambda 요청 본문. 나머지 값은 jobId 로 DB 에서 읽음
export interface GenerationRequest {
  jobId: string;
  // 사용자 GitHub 토큰 (커밋 상세 조회용, 저장하거나 로그에 남기지 않음)
  githubToken: string;
}

// Realtime Broadcast: 채널 이름은 draft_prompt.channel, 이벤트 이름은 고정
export const GENERATION_BROADCAST_EVENT = 'job-update';

// 신호일 뿐이며, 받는 쪽은 Next.js 상태 조회로 실제 상태를 다시 읽음
export interface GenerationBroadcastPayload {
  jobId: string;
  status: GenerationStatus;
  step: GenerationStep;
}

// 실패 사유 (draft_prompt.error_code)
export type GenerationErrorCode =
  | 'timeout'
  | 'github_reauth'
  | 'github_unavailable'
  | 'llm_failed'
  | 'invalid_result'
  | 'runner_unavailable'
  | 'quota_exceeded'
  | 'internal';

// 요청 본문 검증 (API Gateway 모델 검증을 거치지만 Lambda 에서도 한 번 더 확인)
export const parseGenerationRequest = (
  event: unknown,
): GenerationRequest | null => {
  if (typeof event !== 'object' || event === null) {
    return null;
  }

  const { jobId, githubToken } = event as Record<string, unknown>;

  if (
    typeof jobId !== 'string' ||
    jobId.length === 0 ||
    jobId.length > 64 ||
    typeof githubToken !== 'string' ||
    githubToken.length === 0
  ) {
    return null;
  }

  return { jobId, githubToken };
};
