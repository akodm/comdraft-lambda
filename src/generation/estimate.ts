import type { Length } from '../prompts/types.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_FILL_OUTPUT,
  ESTIMATE_OUTLINE_CODE,
  ESTIMATE_PLAN_OUTPUT,
  ESTIMATE_REVIEW_OUTPUT,
  ESTIMATE_WRITE_OUTPUT,
  HUNK_TOKEN_BUDGET,
} from './limits.ts';

// Claude 를 부르기 전에 잰 입력 크기 (토큰 추정치)
export interface PreparedTokens {
  // 기획 단계 커밋 카탈로그
  catalogTokens: number;
  // 가리지 않은 hunk 본문 합
  hunkTokens: number;
  // 참고 링크 본문 합
  linkTokens: number;
  // 사용자 요청 문구
  requestTokens: number;
}

// 단계별 system 프롬프트 토큰
export interface SystemTokens {
  plan: number;
  analyze: number;
  write: number;
  review: number;
  revise: number;
}

/**
 * 작업 한 건이 쓸 토큰 예상량 (할당량 검사용, 넉넉하게 잡음)
 * - 요청은 기획·분석·작성 단계와 검토 입력에 들어가서 네 번 센다
 * - hunk 는 분석 단계 상한(HUNK_TOKEN_BUDGET)까지만 넘기므로 그만큼만 센다
 * - 기획 출력은 다음 단계 입력으로도 들어가므로 두 번 센다
 * - 분석 출력은 작성·검토·고쳐 쓰기 입력으로도 들어가므로 네 번 센다 (출력 한 번 + 입력 세 번)
 * - 작성·검토·고쳐 쓰기 입력에는 코드 원문이 들어가므로 그 여유분(ESTIMATE_OUTLINE_CODE)을 세 번 센다
 * - 작성 출력(초안)은 검토·고쳐 쓰기 입력이 되고 고쳐 쓰기 출력도 같은 크기라 네 번 센다 (출력 두 번 + 입력 두 번)
 * - 검토 출력은 고쳐 쓰기 입력으로도 들어가므로 두 번 센다 (검토·고쳐 쓰기 system 은 한 번씩)
 */
export const estimateJobTokens = (
  prepared: PreparedTokens,
  length: Length,
  systemTokens: SystemTokens,
): number =>
  systemTokens.plan +
  systemTokens.analyze +
  systemTokens.write +
  systemTokens.review +
  systemTokens.revise +
  prepared.requestTokens * 4 +
  prepared.catalogTokens +
  Math.min(prepared.hunkTokens, HUNK_TOKEN_BUDGET) +
  prepared.linkTokens +
  ESTIMATE_PLAN_OUTPUT * 2 +
  ESTIMATE_ANALYSIS_OUTPUT * 4 +
  ESTIMATE_OUTLINE_CODE * 3 +
  ESTIMATE_WRITE_OUTPUT[length] * 4 +
  ESTIMATE_REVIEW_OUTPUT * 2;

/**
 * 빈칸 채우기 작업 한 건의 토큰 예상량 (Claude 한 번 호출)
 * - user 는 실제로 보낼 사용자 입력(본문, 저장한 분석, 질문, 답, 옵션)을 잰 값
 */
export const estimateFillTokens = (promptTokens: { system: number; user: number }): number =>
  promptTokens.system + promptTokens.user + ESTIMATE_FILL_OUTPUT;
