import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GenerationBroadcastPayload } from './contract.ts';
import { GithubApiError } from './errors.ts';
import type { CommitDetail } from './github.ts';
import type { JobContext, JobStore, QuotaReservation } from './jobs.ts';
import type { Pipeline } from './pipeline.ts';
import { createPlaceholderPipeline } from './placeholder-pipeline.ts';
import { MIN_REMAINING_MS, runJob, type RunJobDependencies } from './run-job.ts';

const CONTEXT: JobContext = {
  prompt: '이미지 지연 로딩 정리',
  tone: 'friendly',
  postType: 'tutorial',
  length: 'medium',
  requiredBlocks: [],
  locale: 'ko',
  referenceUrls: [],
  commitShas: ['b74e3d0aaaa', 'a8f2c91bbbb'],
  owner: 'akodm',
  repo: 'comdraft',
};

const commit = (sha: string, message: string): CommitDetail => ({
  sha,
  message,
  htmlUrl: `https://github.com/akodm/comdraft/commit/${sha}`,
  files: [{ filename: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }],
});

// 메모리에서 상태 전이를 흉내 내는 작업 저장소
const createMemoryJobs = (
  initialStatus = 'queued',
  reservation: QuotaReservation = 'reserved',
) => {
  const state = {
    status: initialStatus,
    step: 0,
    result: null as string | null,
    errorCode: null as string | null,
    estimatedTokens: null as number | null,
    usedTokens: 0,
  };

  const jobs: JobStore = {
    markRunning: async () => {
      if (state.status !== 'queued') {
        return null;
      }

      state.status = 'running';
      return { channel: 'channel-uuid' };
    },
    loadContext: async () => CONTEXT,
    markStep: async (_jobId, step) => {
      if (state.status !== 'running') {
        return false;
      }

      state.step = step;
      return true;
    },
    complete: async (_jobId, result) => {
      if (state.status !== 'running') {
        return false;
      }

      Object.assign(state, { status: 'completed', step: 3, result });
      return true;
    },
    fail: async (_jobId, errorCode) => {
      if (state.status !== 'queued' && state.status !== 'running') {
        return false;
      }

      Object.assign(state, { status: 'failed', errorCode });
      return true;
    },
    // 실제 저장소처럼 초과여도 예상량은 기록한다 (거부 처리는 실패 기록에 맡김)
    reserveQuota: async (_jobId, estimate) => {
      if (reservation !== 'no_plan') {
        state.estimatedTokens = estimate;
      }

      return reservation;
    },
    addUsage: async (_jobId, tokens) => {
      if (tokens > 0) {
        state.usedTokens += tokens;
      }
    },
  };

  return { jobs, state };
};

const createDependencies = (
  overrides: Partial<RunJobDependencies> = {},
  initialStatus?: string,
  reservation?: QuotaReservation,
) => {
  const { jobs, state } = createMemoryJobs(initialStatus, reservation);
  const signals: GenerationBroadcastPayload[] = [];

  const dependencies: RunJobDependencies = {
    jobs,
    signal: async (_channel, payload) => {
      signals.push(payload);
      return true;
    },
    fetchCommit: async ({ sha }) => commit(sha, `feat: ${sha} 작업`),
    pipeline: createPlaceholderPipeline(),
    remainingTimeMs: () => 5 * 60 * 1000,
    ...overrides,
  };

  return { dependencies, state, signals };
};

// Claude 호출 대신 단계마다 정해 둔 사용량을 보고하는 파이프라인 (stages 에 시작한 단계가 쌓인다)
const createUsagePipeline = (
  usage: { classify: number; analyze: number; write: number },
  failAt?: 'analyze' | 'write',
) => {
  const stages: string[] = [];
  const stage = async (
    name: 'classify' | 'analyze' | 'write',
    onUsage: (tokens: number) => Promise<void>,
  ) => {
    stages.push(name);
    // 실패 단계는 응답을 받지 못한 호출처럼 사용량 없이 던진다
    if (failAt === name) {
      throw new Error(`${name} 실패`);
    }
    await onUsage(usage[name]);
  };

  const pipeline: Pipeline = {
    prepare: async () => ({}),
    estimate: () => 12_345,
    classify: async ({ onUsage }) => stage('classify', onUsage),
    analyze: async ({ onUsage }) => stage('analyze', onUsage),
    write: async ({ onUsage }) => {
      await stage('write', onUsage);
      return '# 결과';
    },
  };

  return { pipeline, stages };
};

describe('runJob', () => {
  it('구분 → 분석 → 작성 단계를 거쳐 결과를 저장하고 단계마다 신호를 보낸다', async () => {
    const { dependencies, state, signals } = createDependencies();

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.equal(state.status, 'completed');
    assert.match(state.result ?? '', /^# /);
    assert.deepEqual(
      signals.map(({ status, step }) => `${status}:${step}`),
      ['running:0', 'running:1', 'running:2', 'completed:3'],
    );
  });

  it('이미 시작했거나 끝난 작업은 다시 실행하지 않는다 (중복 호출)', async () => {
    const { dependencies, signals } = createDependencies({}, 'completed');

    assert.equal(await runJob('job-1', dependencies), 'skipped');
    assert.equal(signals.length, 0);
  });

  it('GitHub 토큰이 만료되면 github_reauth 로 실패 처리한다', async () => {
    const { dependencies, state, signals } = createDependencies({
      fetchCommit: async () => {
        throw new GithubApiError(401);
      },
    });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(state.errorCode, 'github_reauth');
    assert.equal(signals.at(-1)?.status, 'failed');
  });

  it('남은 실행 시간이 부족하면 timeout 으로 스스로 실패 처리한다', async () => {
    const { dependencies, state } = createDependencies({
      remainingTimeMs: () => MIN_REMAINING_MS - 1,
    });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(state.errorCode, 'timeout');
  });

  it('할당량을 넘으면 Claude 호출 없이 quota_exceeded, 사용량 0', async () => {
    const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    const { dependencies, state, signals } = createDependencies({ pipeline }, undefined, 'exceeded');

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.deepEqual(stages, []);
    assert.equal(state.status, 'failed');
    assert.equal(state.errorCode, 'quota_exceeded');
    assert.equal(state.estimatedTokens, 12_345);
    assert.equal(state.usedTokens, 0);
    assert.equal(signals.at(-1)?.status, 'failed');
  });

  it('정책이 없으면 internal 로 실패, Claude 호출 없음', async () => {
    const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    const { dependencies, state } = createDependencies({ pipeline }, undefined, 'no_plan');

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.deepEqual(stages, []);
    assert.equal(state.errorCode, 'internal');
    assert.equal(state.usedTokens, 0);
  });

  it('단계마다 사용량이 더해진다', async () => {
    const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    const { dependencies, state } = createDependencies({ pipeline });

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.deepEqual(stages, ['classify', 'analyze', 'write']);
    assert.equal(state.estimatedTokens, 12_345);
    assert.equal(state.usedTokens, 6_000);
  });

  it('두 번째 단계 실패 시 첫 단계 사용량 유지', async () => {
    const { pipeline, stages } = createUsagePipeline(
      { classify: 1_000, analyze: 2_000, write: 3_000 },
      'analyze',
    );
    const { dependencies, state } = createDependencies({ pipeline });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.deepEqual(stages, ['classify', 'analyze']);
    assert.equal(state.status, 'failed');
    assert.equal(state.errorCode, 'internal');
    assert.equal(state.usedTokens, 1_000);
  });

  it('예상량을 잰 뒤 남은 시간이 부족하면 Claude 를 부르지 않고 timeout', async () => {
    const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    let calls = 0;
    // 준비(커밋·링크) 전에는 넉넉하고, 준비가 끝난 뒤에는 부족하다
    const { dependencies, state } = createDependencies({
      pipeline,
      remainingTimeMs: () => (++calls === 1 ? 5 * 60 * 1000 : MIN_REMAINING_MS - 1),
    });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.deepEqual(stages, []);
    assert.equal(state.errorCode, 'timeout');
  });
});
