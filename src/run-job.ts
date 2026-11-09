import type { GenerationStatus, GenerationStep } from './contract.ts';
import type { SendSignal } from './broadcast.ts';
import { GenerationFailure, toGenerationFailure } from './errors.ts';
import { fetchCommits, type FetchCommit } from './github.ts';
import type { JobStore } from './jobs.ts';
import type { Pipeline, PipelineInput } from './pipeline.ts';

// 다음 단계를 시작하기 위해 남아 있어야 하는 실행 시간 (부족하면 스스로 실패 처리 후 종료)
export const MIN_REMAINING_MS = 30_000;

export interface RunJobDependencies {
  jobs: JobStore;
  signal: SendSignal;
  fetchCommit: FetchCommit;
  pipeline: Pipeline;
  // Lambda 남은 실행 시간 (context.getRemainingTimeInMillis)
  remainingTimeMs: () => number;
  // 실패 원인 보고 (Sentry 연동 전까지는 아무것도 하지 않음)
  reportError?: (error: unknown) => void;
}

// skipped: 이미 시작했거나 끝난 작업 (중복 호출), cancelled: 진행 중 다른 곳에서 끝남 (시간 초과 등)
export type RunJobOutcome = 'completed' | 'failed' | 'skipped' | 'cancelled';

/**
 * 작업 한 건 실행: running → 커밋 상세 1회 조회 → 구분(1) → 분석(2) → 작성(3) → 완료
 * - 단계를 마칠 때마다 DB 단계를 갱신하고 Realtime 신호 전송
 * - 어떤 오류든 사유 코드로 실패 기록 (Lambda 가 비정상 종료되면 Next.js 가 시간 초과로 처리)
 */
export const runJob = async (
  jobId: string,
  {
    jobs,
    signal,
    fetchCommit,
    pipeline,
    remainingTimeMs,
    reportError = () => {},
  }: RunJobDependencies,
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

  await notify('running');

  try {
    const context = await jobs.loadContext(jobId);

    if (!context) {
      throw new GenerationFailure('internal');
    }

    const input: PipelineInput = {
      context,
      commits: await fetchCommits(fetchCommit, {
        owner: context.owner,
        repo: context.repo,
        shas: context.commitShas,
      }),
    };

    ensureTime();
    const classified = await pipeline.classify(input);

    if (!(await advance(1))) {
      return 'cancelled';
    }

    ensureTime();
    const analyzed = await pipeline.analyze(input, classified);

    if (!(await advance(2))) {
      return 'cancelled';
    }

    ensureTime();
    const result = await pipeline.write(input, analyzed);

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
