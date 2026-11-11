import { z } from 'zod';

import type { Analysis, Plan } from './schemas.ts';

/**
 * 초안 작성 작업이 분석 단계 뒤 저장하는 재료 (draft_prompt.analysis)
 * - 나중에 같은 초안의 빈칸 채우기가 커밋을 다시 조회하지 않고 앞뒤를 맞추는 데 쓴다
 * - 절별 제목, 사실 문장, 코드에서 볼 점(point), 빈칸 질문만 남긴다
 * - 코드 원문, 코드 위치, 근거 번호, 커밋 메시지·해시는 넣지 않는다 (작고, 출처가 글로 새지 않게)
 */
const StoredAnalysisSchema = z.object({
  version: z.literal(1),
  sections: z.array(
    z.object({
      heading: z.string(),
      facts: z.array(z.string()),
      points: z.array(z.string()),
      questions: z.array(z.string()),
    }),
  ),
});

export type StoredAnalysis = z.infer<typeof StoredAnalysisSchema>;

// 검증한 기획·분석 결과 → 저장 형태 (절 순서는 기획 순서)
export const toStoredAnalysis = (plan: Plan, analysis: Analysis): StoredAnalysis => ({
  version: 1,
  sections: plan.sections.map((section, index) => ({
    heading: section.heading,
    facts: analysis.facts.filter((fact) => fact.section === index).map((fact) => fact.text),
    points: analysis.code.filter((pick) => pick.section === index).map((pick) => pick.point),
    questions: analysis.unknowns
      .filter((unknown) => unknown.section === index)
      .map((unknown) => unknown.ask),
  })),
});

// jsonb 컬럼 값 → 저장 형태 (드라이버가 문자열로 주더라도 파싱하고, 없거나 형식이 다르면 null)
export const parseStoredAnalysis = (value: unknown): StoredAnalysis | null => {
  let parsed = value;

  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  const result = StoredAnalysisSchema.safeParse(parsed);
  return result.success ? result.data : null;
};
