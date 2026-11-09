import type { JobContext, JobLocale } from '../jobs.ts';
import type { PreparedLink } from '../generation/links.ts';
import type { PreparedCommit, PreparedHunk } from '../generation/prepare.ts';
import type { Analysis, BlankKind, Plan } from '../generation/schemas.ts';

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

interface Stage<I> {
  system: string;
  user: (input: I) => string;
}

// 로케일별 프롬프트 묶음. 로케일을 추가할 때는 이 타입을 채운 파일 하나만 더한다.
export interface PromptPack {
  locale: JobLocale;
  // 세 단계 system 에 모두 들어가는 데이터-지시 분리 문장의 고정 구절 (테스트용)
  dataRuleMarker: string;
  plan: Stage<PlanPromptInput>;
  analyze: Stage<AnalyzePromptInput>;
  write: Stage<WritePromptInput>;
  // 문체 지시
  tone: Record<Tone, string>;
  // 목차 틀
  postType: Record<PostType, string>;
  length: Record<Length, { sections: [number, number]; target: string }>;
  // 필수 블록을 글에 어떻게 반영할지
  requiredBlocks: Record<RequiredBlock, string>;
  // ask 가 비었을 때 기본 문구
  blankDefaults: Record<BlankKind, string>;
  // 글 끝에 붙이는 참고 절 제목
  referencesHeading: string;
}
