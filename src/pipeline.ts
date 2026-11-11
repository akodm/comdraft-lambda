import type { CommitDetail } from './github.ts';
import type { JobContext } from './jobs.ts';
import { GenerationFailure } from './errors.ts';
import { assemble, unwrapOuterFence } from './generation/assemble.ts';
import { estimateJobTokens } from './generation/estimate.ts';
import {
  estimateTokens,
  REVIEW_MIN_REMAINING_MS,
  REVISE_MIN_REMAINING_MS,
} from './generation/limits.ts';
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
  checkRevision,
  findPatternIssues,
  mergeIssues,
  ReviewSchema,
  validateReview,
  type RevisionProblem,
} from './generation/review.ts';
import {
  AnalysisSchema,
  PlanSchema,
  type Analysis,
  type Plan,
} from './generation/schemas.ts';
import { toStoredAnalysis, type StoredAnalysis } from './generation/stored-analysis.ts';
import { missingHeadingLevels, validateAnalysis, validatePlan } from './generation/validate.ts';
import { getPromptPack } from './prompts/index.ts';
import { renderCatalog, resolveOptions } from './prompts/render.ts';

/**
 * 준비 → (예상량 검사) → 구분 → 분석 → 작성 → 검토 단계
 * - 각 단계는 앞 단계 결과를 받아 메모리에서만 넘기고, 마지막 검토 단계가 조립한 결과(Markdown)만 저장됨
 * - 검토는 독자 기준으로 초안을 점검하고, 문제가 있을 때만 고쳐 써서 조립 (어느 단계든 실패하면 원래 초안을 씀)
 * - 고쳐 쓴 초안이 자리표시자·제목 검사에서 거절되면 그 이유를 알려 주고 한 번만 다시 고쳐 씀
 * - createClaudePipeline 이 실제 구현이고, 임시 구현은 placeholder-pipeline.ts 에 있음
 */

export interface PipelineInput {
  context: JobContext;
  commits: CommitDetail[];
  // Claude 응답 하나를 받을 때마다 그 사용 토큰을 기록
  onUsage: (tokens: number) => Promise<void>;
  // 분석 단계를 마치면 나중의 빈칸 채우기가 쓸 재료를 저장
  onAnalysis?: (analysis: StoredAnalysis) => Promise<void>;
}

export interface Pipeline<P = unknown, C = unknown, A = unknown, W = unknown> {
  // 준비: Claude 를 부르기 전에 커밋·참고 링크를 정리
  prepare: (input: PipelineInput) => Promise<P>;
  // 준비물로 작업 전체의 토큰 예상량 계산 (할당량 검사용)
  estimate: (input: PipelineInput, prepared: P) => number;
  // 1단계: 커밋을 주제/작업 단위로 구분
  classify: (input: PipelineInput, prepared: P) => Promise<C>;
  // 2단계: 구분 결과를 바탕으로 변경 내용 분석
  analyze: (input: PipelineInput, classified: C) => Promise<A>;
  // 3단계: 분석 결과로 글 초안(Markdown, 자리표시자 형태) 작성
  write: (input: PipelineInput, analyzed: A) => Promise<W>;
  // 4단계: 초안을 독자 기준으로 검토하고 필요할 때만 고쳐 쓴 뒤 조립해 최종 Markdown 을 만든다
  review: (input: PipelineInput, written: W) => Promise<string>;
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

// 작성 단계 결과: 아직 조립하지 않은 초안과 작성에 쓴 hunk
export interface Written extends Analyzed {
  draft: string;
  selected: Map<string, PreparedHunk>;
}

export interface ClaudePipelineDependencies {
  llm: LlmClient;
  fetchLinks: (urls: string[]) => Promise<PreparedLink[]>;
  // Lambda 남은 실행 시간 (검토·고쳐 쓰기를 건너뛸지 정함)
  remainingTimeMs: () => number;
  // 검토 단계 실패 보고 (없으면 조용히 넘어감)
  reportError?: (error: unknown) => void;
}

const PLAN_STAGE = { effort: 'low', maxTokens: 8_000 } as const;
// 분석은 hunk 원문과 링크 본문이 함께 들어가 입력이 크다. medium 이면 생각만으로 출력 상한(16,000)을 다 써
// 결과 없이 끊기는 일이 있어(2fdbd57 커밋 실측: 생각 14,000~16,000토큰) low 로 둔다 (low 실측 13초, 출력 약 3,000토큰)
const ANALYZE_STAGE = { effort: 'low', maxTokens: 16_000 } as const;
const REVIEW_STAGE = { effort: 'low', maxTokens: 4_000 } as const;
// 고쳐 쓰기 최대 횟수 (처음 한 번 + 검사에서 거절되면 이유를 알려 주고 한 번 더)
const REVISE_ATTEMPTS = 2;
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
  remainingTimeMs,
  reportError,
}: ClaudePipelineDependencies): Pipeline<Prepared, Classified, Analyzed, Written> => ({
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

    const planContext = {
      hunkIds: new Set(
        [...hunks.values()].filter((h) => !h.redacted).map((h) => h.id),
      ),
      linkIds: new Set(links.map((link) => link.id)),
      length: context.length,
    };
    const requiredBlocks = resolveOptions(context).requiredBlocks;
    const requestPlan = async (missingLevels?: number[]) =>
      validatePlan(
        await llm.parse({
          system: pack.plan.system,
          user: pack.plan.user({ context, commits, links, missingLevels }),
          schema: PlanSchema,
          onUsage,
          ...PLAN_STAGE,
        }),
        planContext,
      );

    const plan = await requestPlan();
    const missing = missingHeadingLevels(plan, requiredBlocks);

    if (missing.length === 0) {
      return { ...prepared, plan };
    }

    // 필수 제목 수준이 빠졌으면 빠진 수준을 알려 주고 한 번만 다시 기획한다 (덜 빠진 쪽을 쓴다)
    const replanned = await requestPlan(missing);
    const better =
      missingHeadingLevels(replanned, requiredBlocks).length < missing.length ? replanned : plan;

    return { ...prepared, plan: better };
  },

  analyze: async ({ context, onUsage, onAnalysis }, classified) => {
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
      ...ANALYZE_STAGE,
    });

    const analysis = validateAnalysis(raw, {
      plan,
      hunks: new Map(selected.map((hunk) => [hunk.id, hunk])),
      commitIds: new Set(commits.map((commit) => commit.id)),
      linkIds: new Set(links.map((link) => link.id)),
      blankDefaults: pack.blankDefaults,
      length: context.length,
    });

    // 검증을 거친 분석(빈칸 상한 적용 후)만 저장한다
    await onAnalysis?.(toStoredAnalysis(plan, analysis));

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

    const draft = await llm.write({
      system: pack.write.system,
      user: pack.write.user({ context, plan, analysis, hunks: selected, links }),
      onUsage,
      ...WORK_STAGE,
    });

    return { ...analyzed, draft, selected };
  },

  review: async ({ context, onUsage }, written) => {
    const pack = getPromptPack(context.locale);
    const { commits, links, plan, analysis, selected } = written;
    // 검토 quote 가 초안에서 찾아지도록 작성이 감싼 바깥 펜스를 먼저 푼다
    const draft = unwrapOuterFence(written.draft);
    const base = { context, plan, analysis, hunks: selected, links, draft };
    const assembleInput = {
      analysis,
      commits,
      hunks: selected,
      links,
      request: context.prompt,
      referencesHeading: pack.referencesHeading,
    };
    // 검토 결과로 쓸 초안 (고쳐 쓴 초안이 없거나 쓸 수 없으면 원래 초안)
    let assembled: string | null = null;

    // 검토는 덤이라 LLM 단계(GenerationFailure)가 실패해도 원래 초안으로 조립한다
    // 그 밖의 오류(사용량 기록 실패 등)는 작업 실패로 이어지도록 그대로 던진다
    try {
      if (remainingTimeMs() >= REVIEW_MIN_REMAINING_MS) {
        const raw = await llm.parse({
          system: pack.review.system,
          user: pack.review.user(base),
          schema: ReviewSchema,
          onUsage,
          ...REVIEW_STAGE,
        });
        // 패턴으로 찾은 메타 문장·전언·추측은 모델 검토가 놓쳐도 고쳐 쓰기가 다루게 앞에 넣는다
        const issues = mergeIssues(findPatternIssues(draft, pack.reviewPatterns), validateReview(raw, draft));

        const linkIds = new Set(links.map((link) => link.id));
        // 고쳐 쓴 초안이 검사에서 거절되면 그 이유를 알려 주고 한 번만 다시 고쳐 쓴다 (시간이 남을 때만)
        let retry: RevisionProblem | undefined;

        for (
          let attempt = 0;
          issues.length > 0 && attempt < REVISE_ATTEMPTS && remainingTimeMs() >= REVISE_MIN_REMAINING_MS;
          attempt += 1
        ) {
          const revised = await llm.write({
            system: pack.revise.system,
            user: pack.revise.user({ ...base, issues, retry }),
            onUsage,
            ...WORK_STAGE,
          });
          const check = checkRevision(draft, revised, linkIds);

          if ('problem' in check) {
            reportError?.(new GenerationFailure('invalid_result'));
            retry = check.problem;
            continue;
          }

          // 고쳐 쓴 초안이 조립에서 막히면 원래 초안으로 되돌린다 (다시 고쳐 쓰지 않음)
          try {
            assembled = assemble({ ...assembleInput, markdown: check.markdown });
          } catch (error) {
            reportError?.(error);
          }
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof GenerationFailure)) {
        throw error;
      }

      reportError?.(error);
    }

    // 원래 초안을 조립하지 못하면 작업이 실패해야 하므로 어떤 대체 처리도 두지 않는다
    return assembled ?? assemble({ ...assembleInput, markdown: draft });
  },
});
