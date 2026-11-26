import type { GenerationErrorCode } from './contract.ts';

// 실패 원인 파악용 부가 정보 (Sentry 태그로만 보냄, DB 에는 남기지 않음)
// 이유 이름, 상태 코드, 오류 종류, 요청 id 같은 식별자만 넣고 요청·응답 내용, 코드, 토큰은 넣지 않음
export type FailureDetail = Record<string, string | number>;

// 작업을 실패로 끝내야 하는 오류 (사유 코드만 DB 에 남김)
export class GenerationFailure extends Error {
  readonly code: GenerationErrorCode;
  readonly detail: FailureDetail;

  constructor(code: GenerationErrorCode, detail: FailureDetail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// GitHub API 오류 (토큰이나 요청 내용은 메시지에 넣지 않음)
export class GithubApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub API 요청 실패 (${status})`);
    this.status = status;
  }
}

// 어떤 오류든 실패 사유 코드로 변환
export const toGenerationFailure = (error: unknown): GenerationFailure => {
  if (error instanceof GenerationFailure) {
    return error;
  }

  if (error instanceof GithubApiError) {
    return new GenerationFailure(
      error.status === 401 ? 'github_reauth' : 'github_unavailable',
      { githubStatus: error.status },
    );
  }

  return new GenerationFailure('internal', {
    reason: 'unexpected',
    errorClass: error instanceof Error ? error.name : typeof error,
  });
};
