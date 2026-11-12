import { z } from 'zod';

import type { GenerationClarificationQuestion } from '../contract.ts';

// 빈칸 종류. comdraft 저장소의 목록과 똑같이 유지한다. 기본값은 detail.
export const BLANK_KINDS = ['motivation', 'result', 'lesson', 'detail'] as const;
export type BlankKind = (typeof BLANK_KINDS)[number];

// 코드 조각 표시 방식. 기본값은 after (바뀐 뒤 코드)
export const CODE_MODES = ['after', 'diff'] as const;
export type CodeMode = (typeof CODE_MODES)[number];

// 모델이 가리킬 수 있는 근거 번호: 커밋(파일·hunk 포함), 링크, 요청 문구
export const EVIDENCE_PATTERN = /^(C\d+(\.F\d+\.H\d+)?|L\d+|R)$/;

// 글 길이별 절 수 범위. 구조화 출력 호환을 위해 스키마가 아니라 검증 코드에서 확인한다.
export const SECTION_RANGE: Record<'short' | 'medium' | 'long', [number, number]> = {
  short: [2, 3],
  medium: [3, 5],
  long: [5, 7],
};

// 글 전체 빈칸 상한. 분석 결과가 넘으면 앞에서부터 이 수만큼만 남긴다 (프롬프트 안내와 검증 코드가 함께 쓴다).
export const BLANK_LIMIT: Record<'short' | 'medium' | 'long', number> = {
  short: 1,
  medium: 2,
  long: 3,
};

// 참고 링크 역할. 기본값은 other
export const LINK_ROLES = ['docs', 'article', 'discussion', 'other'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

// 링크와 이 글의 관계 설명 최대 글자 수
export const LINK_RELATION_MAX = 120;

export const PlanSchema = z.object({
  // 글의 방향이 갈릴 때 작성자에게 먼저 묻는다. 묻지 않으면 needed 를 false 로 두고 나머지는 비운다
  clarify: z.object({
    needed: z.boolean(),
    reason: z.string(),
    questions: z.array(z.object({ question: z.string(), options: z.array(z.string()) })),
  }),
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
  // role 은 구조화 출력이 enum 을 강제하지 않아 문자열로 받고 검증 코드에서 보정한다
  linkRoles: z.array(z.object({ id: z.string(), role: z.string(), relation: z.string() })),
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
      // 구조화 출력은 enum 을 서버에서 강제하지 않아(설명으로만 옮김) 문자열로 받고 검증 코드에서 보정한다
      mode: z.string(),
      point: z.string(),
    }),
  ),
  unknowns: z.array(
    z.object({
      id: z.string(),
      section: z.number().int(),
      kind: z.string(),
      ask: z.string(),
    }),
  ),
});

// 모델이 돌려준 그대로의 기획 (role 이 목록 밖일 수 있음)
export type RawPlan = z.infer<typeof PlanSchema>;

// 링크 하나의 역할과, 그 링크가 이 글과 맺는 관계
export interface LinkRoleEntry {
  id: string;
  role: LinkRole;
  relation: string;
}

// 검증을 거친 되묻기 (질문에 id 가 붙고 한도에 맞게 보정됨)
export interface ClarifyRequest {
  reason: string;
  questions: GenerationClarificationQuestion[];
}

// 검증을 거친 기획 (linkRoles 는 입력 링크마다 하나씩, role 은 목록 안의 값, clarify 는 묻지 않으면 null)
export type Plan = Omit<RawPlan, 'linkRoles' | 'clarify'> & {
  linkRoles: LinkRoleEntry[];
  clarify: ClarifyRequest | null;
};
// 모델이 돌려준 그대로의 분석 결과 (mode·kind 가 목록 밖일 수 있음)
export type RawAnalysis = z.infer<typeof AnalysisSchema>;

// 검증을 거친 분석 결과 (mode·kind 를 목록 안의 값으로 보정함)
export interface Analysis {
  facts: RawAnalysis['facts'];
  code: (Omit<RawAnalysis['code'][number], 'mode'> & { mode: CodeMode })[];
  unknowns: (Omit<RawAnalysis['unknowns'][number], 'kind'> & { kind: BlankKind })[];
}
