import type { GenerationModel } from '../contract.ts';
import type { Length } from '../prompts/types.ts';
import {
  ESTIMATE_ANALYSIS_OUTPUT,
  ESTIMATE_FILL_OUTPUT,
  ESTIMATE_PLAN_OUTPUT,
  ESTIMATE_WRITE_OUTPUT,
  HUNK_TOKEN_BUDGET,
} from './limits.ts';
import { stagePlan, usageCost, type Stage } from './models.ts';

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

// 호출 하나의 입력·출력 토큰 예상치
export interface Io {
  input: number;
  output: number;
}

/**
 * 작업 한 건의 단계별 입력·출력 토큰 예상치 (할당량 검사용, 넉넉하게 잡음)
 * - 요청은 세 단계에 모두 들어가서 세 번 센다
 * - hunk 는 분석 단계 상한(HUNK_TOKEN_BUDGET)까지만 넘기므로 그만큼만 센다
 * - 기획 출력과 분석 출력은 다음 단계 입력으로도 들어가므로 입력·출력 양쪽에 센다
 * - review·revise 는 예상량에 넣지 않고 실제 사용량으로만 센다 (검토는 덤이라 할당량 검사 기준은 작성까지와 같음)
 * - 세 단계 input + output 의 합은 모델과 상관없이 같다 (모델은 단가에만 영향)
 */
export const estimateStages = (
  prepared: PreparedTokens,
  length: Length,
  systemTokens: SystemTokens,
): Record<'plan' | 'analyze' | 'write', Io> => ({
  plan: {
    input:
      systemTokens.plan + prepared.requestTokens + prepared.catalogTokens + prepared.linkTokens,
    output: ESTIMATE_PLAN_OUTPUT,
  },
  analyze: {
    input:
      systemTokens.analyze +
      prepared.requestTokens +
      ESTIMATE_PLAN_OUTPUT +
      Math.min(prepared.hunkTokens, HUNK_TOKEN_BUDGET),
    output: ESTIMATE_ANALYSIS_OUTPUT,
  },
  write: {
    input: systemTokens.write + prepared.requestTokens + ESTIMATE_ANALYSIS_OUTPUT,
    output: ESTIMATE_WRITE_OUTPUT[length],
  },
});

// 입력·출력을 그 단계 모델의 단가로 센 비용 (캐시는 예상에 넣지 않음)
const ioCost = (model: GenerationModel, stage: Stage, { input, output }: Io): number =>
  usageCost(stagePlan(model, stage).model, { input, output, cacheWrite: 0, cacheRead: 0 });

// 작업 한 건의 비용 예상량 (마이크로달러): 단계마다 그 단계가 실제로 부를 모델의 단가로 계산해 합한다
// (고른 모델이 sonnet·opus 여도 분석은 haiku 단가)
export const estimateJobCost = (
  stages: Record<'plan' | 'analyze' | 'write', Io>,
  model: GenerationModel,
): number =>
  ioCost(model, 'plan', stages.plan) +
  ioCost(model, 'analyze', stages.analyze) +
  ioCost(model, 'write', stages.write);

/**
 * 빈칸 채우기 작업 한 건의 비용 예상량 (Claude 한 번 호출)
 * - user 는 실제로 보낼 사용자 입력(본문, 저장한 분석, 질문, 답, 옵션)을 잰 값
 */
export const estimateFillCost = (
  promptTokens: { system: number; user: number },
  model: GenerationModel,
): number =>
  ioCost(model, 'fill', {
    input: promptTokens.system + promptTokens.user,
    output: ESTIMATE_FILL_OUTPUT,
  });
