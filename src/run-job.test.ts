import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GenerationBroadcastPayload } from './contract.ts';
import { GithubApiError } from './errors.ts';
import type { CommitDetail } from './github.ts';
import type { JobContext, JobStore } from './jobs.ts';
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
const createMemoryJobs = (initialStatus = 'queued') => {
  const state = {
    status: initialStatus,
    step: 0,
    result: null as string | null,
    errorCode: null as string | null,
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
  };

  return { jobs, state };
};

const createDependencies = (
  overrides: Partial<RunJobDependencies> = {},
  initialStatus?: string,
) => {
  const { jobs, state } = createMemoryJobs(initialStatus);
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
});
