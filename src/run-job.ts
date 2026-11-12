import type { GenerationStatus, GenerationStep } from './contract.ts';
import type { SendSignal } from './broadcast.ts';
import { GenerationFailure, toGenerationFailure } from './errors.ts';
import type { BlankFiller } from './fill.ts';
import { fetchCommits, type FetchCommit } from './github.ts';
import type { JobContext, JobStore, QuotaReservation } from './jobs.ts';
import type { UsageReport } from './generation/llm.ts';
import type { Pipeline, PipelineInput } from './pipeline.ts';

// 다음 단계를 시작하기 위해 남아 있어야 하는 실행 시간 (부족하면 스스로 실패 처리 후 종료)
export const MIN_REMAINING_MS = 30_000;

export interface RunJobDependencies<P = unknown, C = unknown, A = unknown, W = unknown> {
  jobs: JobStore;
  signal: SendSignal;
  fetchCommit: FetchCommit;
  pipeline: Pipeline<P, C, A, W>;
  // 빈칸 채우기 작업(kind='fill') 실행기
  filler: BlankFiller;
  // Lambda 남은 실행 시간 (context.getRemainingTimeInMillis)
  remainingTimeMs: () => number;
  // 실패 원인 보고 (Sentry 연동 전까지는 아무것도 하지 않음)
  reportError?: (error: unknown) => void;
}

// skipped: 이미 시작했거나 끝난 작업 (중복 호출), cancelled: 진행 중 다른 곳에서 끝남 (시간 초과 등),
// awaiting_input: 작성 전 되묻기 질문을 저장하고 답을 기다리며 멈춤 (끝난 것이 아니라 답을 받으면 다시 실행됨)
export type RunJobOutcome = 'completed' | 'failed' | 'skipped' | 'cancelled' | 'awaiting_input';

// 작업 실행 결과: 결과 Markdown, 또는 되묻기로 멈춤 (null 은 중간에 다른 곳에서 끝남)
type DraftRun = { kind: 'result'; markdown: string } | { kind: 'paused' };

// 예상량 기록 결과 → 시작할 수 없으면 실패 (초과는 예상량이 이미 기록됐으므로 반드시 실패로 끝내야 한다,
// quota_exceeded 는 사용량 0 으로 셈)
const assertReserved = (reservation: QuotaReservation) => {
  if (reservation === 'exceeded') {
    throw new GenerationFailure('quota_exceeded');
  }

  if (reservation === 'no_plan') {
    throw new GenerationFailure('internal');
  }
};

/**
 * 작업 한 건 실행: running → 커밋 상세 1회 조회 → 준비 → 예상량 검사 → 구분(1) → 분석(2) → 작성·검토 → 완료(3)
 * - 구분 직후 기획이 작성자에게 물어야 한다고 하면(처음 실행만) 질문을 저장하고 답변 대기(awaiting_input)로 멈춘다
 *   (단계는 0 그대로, 완료·실패 처리 없음, 답을 받으면 Next.js 가 다시 대기열에 넣어 처음부터 다시 실행)
 * - 예상 비용이 남은 주간 한도의 허용 비율을 넘으면 Claude 를 부르지 않고 quota_exceeded 로 실패 (사용량은 0 으로 셈)
 * - Claude 응답을 받을 때마다 사용 토큰과 비용(모델 단가로 계산)을 바로 누적 (뒤 단계가 실패해도 쓴 만큼은 남음)
 * - 단계를 마칠 때마다 DB 단계를 갱신하고 Realtime 신호 전송
 * - 어떤 오류든 사유 코드로 실패 기록 (Lambda 가 비정상 종료되면 Next.js 가 시간 초과로 처리)
 * - 초안 작성 작업은 분석 단계 뒤 분석을 저장 (저장 실패는 보고만 하고 작업은 계속)
 * - 빈칸 채우기 작업(kind='fill')은 GitHub 조회와 중간 단계 없이: 예상량 검사 → Claude 1회 → 완료(0 → 3)
 */
export const runJob = async <P = unknown, C = unknown, A = unknown, W = unknown>(
  jobId: string,
  {
    jobs,
    signal,
    fetchCommit,
    pipeline,
    filler,
    remainingTimeMs,
    reportError = () => {},
  }: RunJobDependencies<P, C, A, W>,
): Promise<RunJobOutcome> => {
  const started = await jobs.markRunning(jobId);

  if (!started) {
    return 'skipped';
  }

  let step: GenerationStep = 0;
  const notify = (status: GenerationStatus) =>
    signal(started.channel, { jobId, status, step });

  const ensureTime = () => {
    if (remainingTimeMs() < MIN_REMAINING_MS) {
      throw new GenerationFailure('timeout');
    }
  };

  const advance = async (next: GenerationStep) => {
    if (!(await jobs.markStep(jobId, next))) {
      return false;
    }

    step = next;
    await notify('running');
    return true;
  };

  const onUsage = (usage: UsageReport) => jobs.addUsage(jobId, usage);

  // 빈칸 채우기: 결과 Markdown 문단
  const runFill = async (context: JobContext): Promise<string> => {
    if (!context.blank) {
      throw new GenerationFailure('internal');
    }

    const input = {
      context,
      blank: context.blank,
      analysis: await jobs.loadLatestAnalysis(jobId),
      onUsage,
    };

    assertReserved(await jobs.reserveQuota(jobId, filler.estimate(input)));
    ensureTime();
    return filler.fill(input);
  };

  // 초안 작성: 구분 → (되묻기면 멈춤) → 분석 → 작성 → 검토 (중간에 다른 곳에서 끝났으면 null)
  const runDraft = async (context: JobContext): Promise<DraftRun | null> => {
    const input: PipelineInput = {
      context,
      commits: await fetchCommits(fetchCommit, {
        owner: context.owner,
        repo: context.repo,
        shas: context.commitShas,
      }),
      onUsage,
      // 분석은 나중의 빈칸 채우기를 돕는 재료라 저장에 실패해도 초안 작성은 계속한다
      onAnalysis: async (analysis) => {
        try {
          await jobs.saveAnalysis(jobId, analysis);
        } catch (error) {
          reportError(error);
        }
      },
    };

    ensureTime();
    const prepared = await pipeline.prepare(input);
    assertReserved(
      await jobs.reserveQuota(jobId, pipeline.estimate(input, prepared)),
    );

    // 준비 단계에서 참고 링크를 가져오느라 시간을 썼을 수 있어 다시 확인
    ensureTime();
    const classified = await pipeline.classify(input, prepared);
    const clarify = pipeline.clarification(classified);

    if (clarify) {
      return (await jobs.pauseForInput(jobId, clarify)) ? { kind: 'paused' } : null;
    }

    if (!(await advance(1))) {
      return null;
    }

    ensureTime();
    const analyzed = await pipeline.analyze(input, classified);

    if (!(await advance(2))) {
      return null;
    }

    ensureTime();
    const written = await pipeline.write(input, analyzed);
    // 검토는 시간이 부족하면 스스로 건너뛰므로 앞에서 따로 확인하지 않는다 (단계 표시도 완료 전까지 2 유지)
    return { kind: 'result', markdown: await pipeline.review(input, written) };
  };

  await notify('running');

  try {
    const context = await jobs.loadContext(jobId);

    if (!context) {
      throw new GenerationFailure('internal');
    }

    const run: DraftRun | null =
      context.kind === 'fill'
        ? { kind: 'result', markdown: await runFill(context) }
        : await runDraft(context);

    if (run === null) {
      return 'cancelled';
    }

    if (run.kind === 'paused') {
      await notify('awaiting_input');
      return 'awaiting_input';
    }

    const result = run.markdown;

    if (!result.trim()) {
      throw new GenerationFailure('invalid_result');
    }

    if (!(await jobs.complete(jobId, result))) {
      return 'cancelled';
    }

    step = 3;
    await notify('completed');
    return 'completed';
  } catch (error) {
    reportError(error);

    if (await jobs.fail(jobId, toGenerationFailure(error).code)) {
      await notify('failed');
    }

    return 'failed';
  }
};
