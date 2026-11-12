import type { GenerationModel } from '../contract.ts';
import { isGenerationModel } from '../contract.ts';
import type { Effort } from './llm.ts';

// 모델을 고르는 파이프라인 단계 (plan 은 replan 포함)
export type Stage = 'plan' | 'analyze' | 'write' | 'review' | 'revise' | 'fill';

export interface StageCall {
  model: GenerationModel;
  effort: Effort;
  // 거절(refusal) 시 다시 부를 haiku. 실제 호출 모델이 haiku 면 null
  fallback: { model: 'haiku'; effort: Effort } | null;
}

// haiku 단계별 사고 깊이
const HAIKU_EFFORT: Record<Stage, Effort> = {
  plan: 'medium',
  analyze: 'medium',
  write: 'high',
  review: 'medium',
  revise: 'high',
  fill: 'medium',
};

// sonnet·opus 를 골랐을 때 단계별 사고 깊이 (analyze 는 항상 haiku 라서 쓰지 않음)
const HIGHER_EFFORT: Record<Exclude<Stage, 'analyze'>, Effort> = {
  plan: 'low',
  write: 'medium',
  review: 'low',
  revise: 'medium',
  fill: 'low',
};

// 고른 모델에서 단계별로 실제 부를 모델과 사고 깊이를 정함
export const stagePlan = (selected: GenerationModel, stage: Stage): StageCall => {
  if (selected === 'haiku' || stage === 'analyze') {
    return { model: 'haiku', effort: HAIKU_EFFORT[stage], fallback: null };
  }

  return {
    model: selected,
    effort: HIGHER_EFFORT[stage],
    fallback: { model: 'haiku', effort: HAIKU_EFFORT[stage] },
  };
};

export interface UsageTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// 단가: 마이크로달러 / 100만 토큰 (= 달러 / 100만 토큰 × 1,000,000). 정수로 두어 합산 오차를 막음
interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export const MODEL_PRICES: {
  haiku: { base: Price; long: Price };
  sonnet: Price;
  opus: Price;
} = {
  haiku: {
    base: { input: 100_000, output: 500_000, cacheWrite: 125_000, cacheRead: 10_000 },
    // 프롬프트가 HAIKU_LONG_PROMPT_TOKENS 를 넘는 호출
    long: { input: 500_000, output: 2_500_000, cacheWrite: 625_000, cacheRead: 50_000 },
  },
  sonnet: { input: 2_000_000, output: 10_000_000, cacheWrite: 2_500_000, cacheRead: 100_000 },
  opus: { input: 4_000_000, output: 20_000_000, cacheWrite: 5_000_000, cacheRead: 200_000 },
};

// haiku 는 프롬프트(입력 + 캐시 쓰기 + 캐시 읽기)가 이 값을 넘는 호출만 long 단가
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;

const priceOf = (model: GenerationModel, usage: UsageTokens): Price => {
  if (model !== 'haiku') {
    return MODEL_PRICES[model];
  }

  const prompt = usage.input + usage.cacheWrite + usage.cacheRead;

  return prompt > HAIKU_LONG_PROMPT_TOKENS ? MODEL_PRICES.haiku.long : MODEL_PRICES.haiku.base;
};

// 호출 하나의 비용 (마이크로달러, 올림)
export const usageCost = (model: GenerationModel, usage: UsageTokens): number => {
  const price = priceOf(model, usage);
  const scaled =
    usage.input * price.input +
    usage.output * price.output +
    usage.cacheWrite * price.cacheWrite +
    usage.cacheRead * price.cacheRead;

  return Math.ceil(scaled / 1_000_000);
};

// DB·요청의 모르는 값은 haiku
export const toModel = (value: unknown): GenerationModel =>
  isGenerationModel(value) ? value : 'haiku';
