import type { CommitDetail } from './github.ts';
import type { JobContext } from './jobs.ts';
import { assemble } from './generation/assemble.ts';
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

/**
 * 구분 → 분석 → 작성 단계
 * - 각 단계는 앞 단계 결과를 받아 메모리에서만 넘기고, 마지막 작성 결과(Markdown)만 저장됨
 * - createClaudePipeline 이 실제 구현이고, 임시 구현은 placeholder-pipeline.ts 에 있음
 */

export interface PipelineInput {
  context: JobContext;
  commits: CommitDetail[];
}

export interface Pipeline<C = unknown, A = unknown> {
  // 1단계: 커밋을 주제/작업 단위로 구분
  classify: (input: PipelineInput) => Promise<C>;
  // 2단계: 구분 결과를 바탕으로 변경 내용 분석
  analyze: (input: PipelineInput, classified: C) => Promise<A>;
  // 3단계: 분석 결과로 글 초안(Markdown) 작성
  write: (input: PipelineInput, analyzed: A) => Promise<string>;
}

// 기획 단계 결과 (뒤 단계가 같은 준비물을 다시 만들지 않도록 함께 넘김)
export interface Classified {
  commits: PreparedCommit[];
  hunks: Map<string, PreparedHunk>;
  links: PreparedLink[];
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

export const createClaudePipeline = ({
  llm,
  fetchLinks,
}: ClaudePipelineDependencies): Pipeline<Classified, Analyzed> => ({
  classify: async ({ context, commits: details }) => {
    const pack = getPromptPack(context.locale);
    const commits = prepareCommits(details);
    const hunks = indexHunks(commits);
    const links = await safeFetchLinks(fetchLinks, context.referenceUrls);

    const raw = await llm.parse({
      system: pack.plan.system,
      user: pack.plan.user({ context, commits, links }),
      schema: PlanSchema,
      ...PLAN_STAGE,
    });

    const plan = validatePlan(raw, {
      hunkIds: new Set(
        [...hunks.values()].filter((h) => !h.redacted).map((h) => h.id),
      ),
      linkIds: new Set(links.map((link) => link.id)),
      length: context.length,
    });

    return { commits, hunks, links, plan };
  },

  analyze: async ({ context }, classified) => {
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

  write: async ({ context }, analyzed) => {
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
