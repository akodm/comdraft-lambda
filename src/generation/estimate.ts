import type { Length } from '../prompts/types.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_FILL_OUTPUT,
  ESTIMATE_PLAN_OUTPUT,
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
}

/**
 * 작업 한 건이 쓸 토큰 예상량 (할당량 검사용, 넉넉하게 잡음)
 * - 요청은 세 단계에 모두 들어가서 세 번 센다
 * - hunk 는 분석 단계 상한(HUNK_TOKEN_BUDGET)까지만 넘기므로 그만큼만 센다
 * - 기획 출력과 분석 출력은 다음 단계 입력으로도 들어가므로 두 번 센다
 * - review·revise 는 예상량에 넣지 않고 실제 사용량으로만 센다 (검토는 덤이라 할당량 검사 기준은 작성까지와 같음)
 */
export const estimateJobTokens = (
  prepared: PreparedTokens,
  length: Length,
  systemTokens: SystemTokens,
): number =>
  systemTokens.plan +
  systemTokens.analyze +
  systemTokens.write +
  prepared.requestTokens * 3 +
  prepared.catalogTokens +
  Math.min(prepared.hunkTokens, HUNK_TOKEN_BUDGET) +
  prepared.linkTokens +
  ESTIMATE_PLAN_OUTPUT * 2 +
  ESTIMATE_ANALYSIS_OUTPUT * 2 +
  ESTIMATE_WRITE_OUTPUT[length];

/**
 * 빈칸 채우기 작업 한 건의 토큰 예상량 (Claude 한 번 호출)
 * - user 는 실제로 보낼 사용자 입력(본문, 저장한 분석, 질문, 답, 옵션)을 잰 값
 */
export const estimateFillTokens = (promptTokens: { system: number; user: number }): number =>
  promptTokens.system + promptTokens.user + ESTIMATE_FILL_OUTPUT;
