import { sanitizeFill } from './generation/assemble.ts';
import { estimateFillCost } from './generation/estimate.ts';
import { estimateTokens } from './generation/limits.ts';
import type { LlmClient, OnUsage } from './generation/llm.ts';
import { stagePlan } from './generation/models.ts';
import type { StoredAnalysis } from './generation/stored-analysis.ts';
import type { JobBlank, JobContext } from './jobs.ts';
import { getPromptPack } from './prompts/index.ts';

/**
 * 빈칸 채우기 (kind='fill'): 글쓴이의 짧은 답을 그 빈칸 자리에 들어갈 문단 1~3개로 다듬는다
 * - 커밋을 다시 조회하지 않고, 지금 본문과 첫 작성 때 저장한 분석만 맥락으로 쓴다
 * - Claude 는 한 번만 부르고, 결과는 조립 단계와 같은 무력화를 거쳐 문단만 남긴다
 */

export interface FillInput {
  context: JobContext;
  blank: JobBlank;
  // 같은 초안의 최근 완료된 초안 작성 작업이 저장한 분석 (없으면 본문과 답만으로 다듬음)
  analysis: StoredAnalysis | null;
  // Claude 응답을 받으면 그 사용량(토큰·비용)을 기록
  onUsage: OnUsage;
}

export interface BlankFiller {
  // 할당량 검사용 비용 예상량 (마이크로달러, Claude 를 부르지 않음)
  estimate: (input: FillInput) => number;
  // Claude 한 번 호출 → 정리한 Markdown 문단
  fill: (input: FillInput) => Promise<string>;
}

// 다듬기는 짧은 글이라 출력 상한만 사고 토큰을 감안해 넉넉하게 (모델·사고 깊이는 작업 모델로 stagePlan 이 정함)
export const FILL_MAX_TOKENS = 8_000;

const buildPrompt = ({ context, blank, analysis }: FillInput) => {
  const pack = getPromptPack(context.locale);
  return { system: pack.fill.system, user: pack.fill.user({ context, blank, analysis }) };
};

// 인라인 코드로 인정하는 근거: 지금 본문, 저장한 분석, 질문, 답
const evidenceOf = ({ blank, analysis }: FillInput): string =>
  [
    blank.context,
    blank.question,
    blank.answer,
    ...(analysis?.sections ?? []).flatMap((section) => [
      section.heading,
      ...section.facts,
      ...section.points,
    ]),
  ].join('\n');

export const createClaudeFiller = ({ llm }: { llm: LlmClient }): BlankFiller => ({
  estimate: (input) => {
    const { system, user } = buildPrompt(input);
    return estimateFillCost(
      { system: estimateTokens(system), user: estimateTokens(user) },
      input.context.model,
    );
  },

  fill: async (input) => {
    const markdown = await llm.write({
      ...buildPrompt(input),
      onUsage: input.onUsage,
      call: stagePlan(input.context.model, 'fill'),
      maxTokens: FILL_MAX_TOKENS,
    });

    return sanitizeFill(markdown, evidenceOf(input));
  },
});
