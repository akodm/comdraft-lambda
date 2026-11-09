import { z } from 'zod';

// 빈칸 종류. comdraft 저장소의 목록과 똑같이 유지한다. 기본값은 detail.
export const BLANK_KINDS = ['motivation', 'result', 'lesson', 'detail'] as const;
export type BlankKind = (typeof BLANK_KINDS)[number];

// 모델이 가리킬 수 있는 근거 번호: 커밋(파일·hunk 포함), 링크, 요청 문구
export const EVIDENCE_PATTERN = /^(C\d+(\.F\d+\.H\d+)?|L\d+|R)$/;

// 글 길이별 절 수 범위. 구조화 출력 호환을 위해 스키마가 아니라 검증 코드에서 확인한다.
export const SECTION_RANGE: Record<'short' | 'medium' | 'long', [number, number]> = {
  short: [2, 3],
  medium: [3, 5],
  long: [5, 7],
};

export const PlanSchema = z.object({
  title: z.string(),
  takeaway: z.string(),
  sections: z.array(
    z.object({
      level: z.number().int(),
      heading: z.string(),
      purpose: z.string(),
      hunks: z.array(z.string()),
      links: z.array(z.string()),
    }),
  ),
  excludedCommits: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export const AnalysisSchema = z.object({
  facts: z.array(
    z.object({
      id: z.string(),
      section: z.number().int(),
      text: z.string(),
      evidence: z.array(z.string()),
    }),
  ),
  code: z.array(
    z.object({
      id: z.string(),
      section: z.number().int(),
      from: z.string(),
      startLine: z.number().int(),
      endLine: z.number().int(),
      mode: z.enum(['after', 'diff']),
      point: z.string(),
    }),
  ),
  unknowns: z.array(
    z.object({
      id: z.string(),
      section: z.number().int(),
      kind: z.enum(BLANK_KINDS),
      ask: z.string(),
    }),
  ),
});

export type Plan = z.infer<typeof PlanSchema>;
export type Analysis = z.infer<typeof AnalysisSchema>;
