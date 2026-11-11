import type { JobBlank, JobContext, JobLocale } from '../jobs.ts';
import type { PreparedLink } from '../generation/links.ts';
import type { PreparedCommit, PreparedHunk } from '../generation/prepare.ts';
import type { Analysis, BlankKind, Plan } from '../generation/schemas.ts';
import type { StoredAnalysis } from '../generation/stored-analysis.ts';

// 작성 옵션 값. comdraft lib/studio/options.ts 의 목록과 같게 유지한다.
export const TONES = ['plain', 'friendly', 'professional'] as const;
export type Tone = (typeof TONES)[number];

export const POST_TYPES = ['experience', 'lecture', 'experiment'] as const;
export type PostType = (typeof POST_TYPES)[number];

export const LENGTHS = ['short', 'medium', 'long'] as const;
export type Length = (typeof LENGTHS)[number];

export const REQUIRED_BLOCKS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'list',
  'code',
  'blockquote',
] as const;
export type RequiredBlock = (typeof REQUIRED_BLOCKS)[number];

export interface PlanPromptInput {
  context: JobContext;
  commits: PreparedCommit[];
  links: PreparedLink[];
}

export interface AnalyzePromptInput {
  context: JobContext;
  plan: Plan;
  commits: PreparedCommit[];
  hunks: PreparedHunk[];
  links: PreparedLink[];
}

export interface WritePromptInput {
  context: JobContext;
  plan: Plan;
  analysis: Analysis;
  hunks: Map<string, PreparedHunk>;
  links: PreparedLink[];
}

// 빈칸 채우기: 지금 본문(대상 자리 {{target}}), 첫 작성 때 저장한 분석(없을 수 있음), 질문과 답
export interface FillPromptInput {
  context: JobContext;
  blank: JobBlank;
  analysis: StoredAnalysis | null;
}

interface Stage<I> {
  system: string;
  user: (input: I) => string;
}

// 로케일별 프롬프트 묶음. 로케일을 추가할 때는 이 타입을 채운 파일 하나만 더한다.
export interface PromptPack {
  locale: JobLocale;
  // 세 단계 system 에 모두 들어가는 데이터-지시 분리 문장의 고정 구절 (테스트용)
  dataRuleMarker: string;
  // 기획·작성 system 에 들어가는 글쓴이 목소리 규칙의 고정 구절 (테스트용)
  voiceRuleMarker: string;
  plan: Stage<PlanPromptInput>;
  analyze: Stage<AnalyzePromptInput>;
  write: Stage<WritePromptInput>;
  // 빈칸 하나를 글쓴이 답으로 다듬는 단계 (초안 작성과 별개의 작업)
  fill: Stage<FillPromptInput>;
  // 문체 지시
  tone: Record<Tone, string>;
  // 글의 흐름 (독자를 이끌어 가는 순서)
  postType: Record<PostType, string>;
  // 절 수 범위, 글 전체 빈칸 상한, 본문 분량
  length: Record<Length, { sections: [number, number]; blanks: number; target: string }>;
  // 필수 블록을 글에 어떻게 반영할지
  requiredBlocks: Record<RequiredBlock, string>;
  // ask 가 비었을 때 기본 문구
  blankDefaults: Record<BlankKind, string>;
  // 글 끝에 붙이는 참고 절 제목
  referencesHeading: string;
}
