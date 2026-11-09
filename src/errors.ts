import type { GenerationErrorCode } from './contract.ts';

// 작업을 실패로 끝내야 하는 오류 (사유 코드만 DB 에 남김)
export class GenerationFailure extends Error {
  readonly code: GenerationErrorCode;

  constructor(code: GenerationErrorCode) {
    super(code);
    this.code = code;
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
    );
  }

  return new GenerationFailure('internal');
};
