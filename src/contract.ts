/**
 * AI 초안 작성 작업 계약 (comdraft Next.js 의 lib/generation/contract.ts 와 같게 유지)
 * - 요청 형식, Broadcast 이벤트, 오류 코드, 시간 제한이 바뀌면 양쪽을 함께 수정
 * - 초안 작성(draft) 작업을 마치면 결과와 함께 분석 단계가 고른 기술 태그 배열을 draft_prompt.tags 에 기록
 *   (느슨하게만 정리, 앱이 반영할 때 표기 규칙으로 정규화, 빈칸 채우기는 빈 배열)
 */

// 작업 상태 (draft_prompt.status)
// awaiting_input: 기획이 되물어 작성자의 답을 기다리는 중 (Lambda 는 멈춰 있음)
export type GenerationStatus = 'queued' | 'running' | 'awaiting_input' | 'completed' | 'failed';

// 완료한 단계 (0: 시작 전, 1: 구분, 2: 분석, 3: 작성)
// 빈칸 채우기 작업은 중간 단계 없이 0 에서 완료(3)로 바로 넘어감
export type GenerationStep = 0 | 1 | 2 | 3;

// 작업 종류 (draft_prompt.kind): 초안 작성 / 빈칸 채우기
export type GenerationJobKind = 'draft' | 'fill';

// 빈칸 채우기 본문 스냅숏(draft_prompt.blank_context)에서 채울 자리를 가리키는 한 줄
// (comdraft lib/generation/blank-fill.ts 의 FILL_TARGET_MARKER 와 같은 값)
export const FILL_TARGET_MARKER = '{{target}}';

// 작성에 쓰는 모델 (draft_prompt.model, 기본값 haiku)
export const GENERATION_MODELS = ['haiku', 'sonnet', 'opus'] as const;
export type GenerationModel = (typeof GENERATION_MODELS)[number];

// 모델별 Anthropic 모델 ID
export const GENERATION_MODEL_IDS: Record<GenerationModel, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
};

export const isGenerationModel = (value: unknown): value is GenerationModel =>
  GENERATION_MODELS.some((model) => model === value);

// Lambda 전체 제한 시간 (terraform lambda_timeout_seconds 720초와 같게 유지)
export const GENERATION_LAMBDA_TIMEOUT_MS = 12 * 60 * 1000;

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
  // 작성자가 질문 카드에서 취소
  | 'cancelled'
  | 'internal';

// 작성 전 되묻기: 기획이 던진 질문 하나 (보기가 없으면 직접 입력만)
export interface GenerationClarificationQuestion {
  id: string;
  question: string;
  options: string[];
}

// 작성자의 답 하나 (질문 id 로 연결)
export interface GenerationClarificationAnswer {
  id: string;
  answer: string;
}

// draft_prompt.clarification (null 이면 아직 묻지 않은 작업)
export interface GenerationClarification {
  reason: string;
  questions: GenerationClarificationQuestion[];
  // null: 답변 대기, 배열: 답함 (답한 질문만), 'skipped': 그냥 작성
  answers: GenerationClarificationAnswer[] | 'skipped' | null;
}

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
