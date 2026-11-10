import type { CommitDetail } from './github.ts';
import type { JobContext } from './jobs.ts';
import { assemble } from './generation/assemble.ts';
import { estimateJobTokens } from './generation/estimate.ts';
import { estimateTokens } from './generation/limits.ts';
import { fetchReferenceLinks, type PreparedLink } from './generation/links.ts';
import type { LlmClient } from './generation/llm.ts';
import {
  indexHunks,
  prepareCommits,
  selectHunks,
  type PreparedCommit,
  type PreparedHunk,
} from './generation/prepare.ts';
import {
  AnalysisSchema,
  PlanSchema,
  type Analysis,
  type Plan,
} from './generation/schemas.ts';
import { validateAnalysis, validatePlan } from './generation/validate.ts';
import { getPromptPack } from './prompts/index.ts';
import { renderCatalog, resolveOptions } from './prompts/render.ts';

/**
 * 준비 → (예상량 검사) → 구분 → 분석 → 작성 단계
 * - 각 단계는 앞 단계 결과를 받아 메모리에서만 넘기고, 마지막 작성 결과(Markdown)만 저장됨
 * - createClaudePipeline 이 실제 구현이고, 임시 구현은 placeholder-pipeline.ts 에 있음
 */

export interface PipelineInput {
  context: JobContext;
  commits: CommitDetail[];
  // Claude 응답 하나를 받을 때마다 그 사용 토큰을 기록
  onUsage: (tokens: number) => Promise<void>;
}

export interface Pipeline<P = unknown, C = unknown, A = unknown> {
  // 준비: Claude 를 부르기 전에 커밋·참고 링크를 정리
  prepare: (input: PipelineInput) => Promise<P>;
  // 준비물로 작업 전체의 토큰 예상량 계산 (할당량 검사용)
  estimate: (input: PipelineInput, prepared: P) => number;
  // 1단계: 커밋을 주제/작업 단위로 구분
  classify: (input: PipelineInput, prepared: P) => Promise<C>;
  // 2단계: 구분 결과를 바탕으로 변경 내용 분석
  analyze: (input: PipelineInput, classified: C) => Promise<A>;
  // 3단계: 분석 결과로 글 초안(Markdown) 작성
  write: (input: PipelineInput, analyzed: A) => Promise<string>;
}

// Claude 를 부르기 전 준비물 (뒤 단계가 같은 준비물을 다시 만들지 않도록 계속 함께 넘김)
export interface Prepared {
  commits: PreparedCommit[];
  hunks: Map<string, PreparedHunk>;
  links: PreparedLink[];
}

// 기획 단계 결과
export interface Classified extends Prepared {
  plan: Plan;
}

export interface Analyzed extends Classified {
  analysis: Analysis;
}

export interface ClaudePipelineDependencies {
  llm: LlmClient;
  fetchLinks: (urls: string[]) => Promise<PreparedLink[]>;
}

const PLAN_STAGE = { effort: 'low', maxTokens: 8_000 } as const;
const WORK_STAGE = { effort: 'medium', maxTokens: 16_000 } as const;

// 링크는 글의 보조 근거라 가져오기에 실패해도 작업을 멈추지 않는다
const safeFetchLinks = async (
  fetchLinks: ClaudePipelineDependencies['fetchLinks'],
  urls: string[],
): Promise<PreparedLink[]> => {
  try {
    return await fetchLinks(urls);
  } catch {
    return [];
  }
};

// 예상량 계산: 실제로 보낼 system 프롬프트·카탈로그·링크 본문과 가리지 않은 hunk 본문을 잰다
const estimatePrepared = (context: JobContext, { commits, hunks, links }: Prepared): number => {
  const pack = getPromptPack(context.locale);
  const sum = (texts: string[]) => texts.reduce((total, text) => total + estimateTokens(text), 0);

  return estimateJobTokens(
    {
      catalogTokens: estimateTokens(renderCatalog(commits)),
      hunkTokens: sum(
        [...hunks.values()].filter((hunk) => !hunk.redacted).map((hunk) => hunk.lines.join('\n')),
      ),
      linkTokens: sum(links.map((link) => link.text)),
      requestTokens: estimateTokens(context.prompt),
    },
    resolveOptions(context).length,
    {
      plan: estimateTokens(pack.plan.system),
      analyze: estimateTokens(pack.analyze.system),
      write: estimateTokens(pack.write.system),
    },
  );
};

export const createClaudePipeline = ({
  llm,
  fetchLinks,
}: ClaudePipelineDependencies): Pipeline<Prepared, Classified, Analyzed> => ({
  prepare: async ({ context, commits: details }) => {
    const commits = prepareCommits(details);
    const hunks = indexHunks(commits);
    const links = await safeFetchLinks(fetchLinks, context.referenceUrls);
    return { commits, hunks, links };
  },

  estimate: ({ context }, prepared) => estimatePrepared(context, prepared),

  classify: async ({ context, onUsage }, prepared) => {
    const pack = getPromptPack(context.locale);
    const { commits, hunks, links } = prepared;

    const raw = await llm.parse({
      system: pack.plan.system,
      user: pack.plan.user({ context, commits, links }),
      schema: PlanSchema,
      onUsage,
      ...PLAN_STAGE,
    });

    const plan = validatePlan(raw, {
      hunkIds: new Set(
        [...hunks.values()].filter((h) => !h.redacted).map((h) => h.id),
      ),
      linkIds: new Set(links.map((link) => link.id)),
      length: context.length,
    });

    return { ...prepared, plan };
  },

  analyze: async ({ context, onUsage }, classified) => {
    const pack = getPromptPack(context.locale);
    const { commits, hunks, links, plan } = classified;
    // 모델이 본 hunk 만 근거로 인정하도록 고른 것만 넘기고 검증한다
    const selected = selectHunks(
      hunks,
      plan.sections.flatMap((section) => section.hunks),
    );

    const raw = await llm.parse({
      system: pack.analyze.system,
      user: pack.analyze.user({ context, plan, commits, hunks: selected, links }),
      schema: AnalysisSchema,
      onUsage,
      ...WORK_STAGE,
    });

    const analysis = validateAnalysis(raw, {
      plan,
      hunks: new Map(selected.map((hunk) => [hunk.id, hunk])),
      commitIds: new Set(commits.map((commit) => commit.id)),
      linkIds: new Set(links.map((link) => link.id)),
      blankDefaults: pack.blankDefaults,
    });

    return { ...classified, analysis };
  },

  write: async ({ context, onUsage }, analyzed) => {
    const pack = getPromptPack(context.locale);
    const { commits, links, plan, analysis } = analyzed;
    // 코드 선택은 분석 단계에서 본 hunk 안에서만 나오므로 같은 집합을 쓴다
    const selected = new Map(
      selectHunks(
        analyzed.hunks,
        plan.sections.flatMap((section) => section.hunks),
      ).map((hunk) => [hunk.id, hunk]),
    );

    const markdown = await llm.write({
      system: pack.write.system,
      user: pack.write.user({ context, plan, analysis, hunks: selected, links }),
      onUsage,
      ...WORK_STAGE,
    });

    return assemble({
      markdown,
      analysis,
      commits,
      hunks: selected,
      links,
      request: context.prompt,
      referencesHeading: pack.referencesHeading,
    });
  },
});
