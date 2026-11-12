import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GenerationBroadcastPayload } from './contract.ts';
import { GithubApiError } from './errors.ts';
import { FILL_TARGET_MARKER } from './contract.ts';
import { createClaudeFiller } from './fill.ts';
import type { LlmClient } from './generation/llm.ts';
import type { StoredAnalysis } from './generation/stored-analysis.ts';
import type { CommitDetail } from './github.ts';
import type { JobContext, JobStore, QuotaReservation } from './jobs.ts';
import type { Pipeline } from './pipeline.ts';
import { createPlaceholderPipeline } from './placeholder-pipeline.ts';
import { MIN_REMAINING_MS, runJob, type RunJobDependencies } from './run-job.ts';

const CONTEXT: JobContext = {
  kind: 'draft',
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
  clarification: null,
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
    analysis: null as StoredAnalysis | null,
    // 같은 초안의 최근 완료 초안 작성 작업이 저장한 분석 (loadLatestAnalysis 가 돌려줌)
    latestAnalysis: null as StoredAnalysis | null,
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
    saveAnalysis: async (_jobId, analysis) => {
      state.analysis = analysis;
    },
    loadLatestAnalysis: async () => state.latestAnalysis,
  };

  return { jobs, state };
};

// 빈칸 채우기용 가짜 LLM (write 호출 수와 받은 입력을 기록, 호출마다 정해 둔 사용량을 보고)
const createFillLlm = (markdown = '첫 화면이 3초 정도 걸렸다.', usage = 700) => {
  const calls: { system: string; user: string }[] = [];
  const llm: LlmClient = {
    parse: async () => {
      calls.push({ system: 'parse', user: '' });
      throw new Error('parse 는 쓰지 않는다');
    },
    write: async (req) => {
      calls.push({ system: req.system, user: req.user });
      await req.onUsage?.(usage);
      return markdown;
    },
  };
  return { llm, calls };
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
    filler: createClaudeFiller({ llm: createFillLlm().llm }),
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
    review: async (_input, written) => `${written}\n\n검토 뒤`,
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

  it('작성 뒤 검토 결과를 저장하고 단계는 1, 2 만 기록한다 (3 은 완료 경로)', async () => {
    const { pipeline } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    const { dependencies, state } = createDependencies({ pipeline });
    const steps: number[] = [];
    const markStep = dependencies.jobs.markStep;
    dependencies.jobs.markStep = async (jobId, step) => {
      steps.push(step);
      return markStep(jobId, step);
    };

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.equal(state.result, '# 결과\n\n검토 뒤');
    assert.deepEqual(steps, [1, 2]);
  });

  it('작업의 초안이 삭제돼 맥락이 없으면 Claude 호출 없이 internal 로 실패한다', async () => {
    const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
    const { dependencies, state, signals } = createDependencies({ pipeline });
    // 초안 삭제로 draft_id 가 null 이 되면 loadContext 의 초안 join 이 행을 찾지 못한다
    dependencies.jobs.loadContext = async () => null;

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.deepEqual(stages, []);
    assert.equal(state.status, 'failed');
    assert.equal(state.errorCode, 'internal');
    assert.equal(state.estimatedTokens, null);
    assert.equal(state.usedTokens, 0);
    assert.equal(signals.at(-1)?.status, 'failed');
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

const BLANK_CONTEXT: JobContext = {
  ...CONTEXT,
  kind: 'fill',
  prompt: '3초 정도 걸렸다',
  commitShas: [],
  blank: {
    id: '6f1c2a4e-0000-4000-8000-000000000001',
    question: '첫 화면이 얼마나 느렸나요?',
    answer: '3초 정도 걸렸다',
    context: `# 지연 로딩\n\n앞 문단이다.\n\n${FILL_TARGET_MARKER}\n\n뒤 문단이다.`,
  },
};

const STORED: StoredAnalysis = {
  version: 1,
  sections: [{ heading: '느린 첫 화면', facts: ['이미지를 모두 먼저 불러왔다'], points: [], questions: [] }],
};

// 빈칸 채우기 작업: GitHub 조회는 횟수만 센다
const createFillDependencies = (
  options: { reservation?: QuotaReservation; context?: JobContext; markdown?: string } = {},
) => {
  const fill = createFillLlm(options.markdown);
  let githubCalls = 0;
  const { pipeline, stages } = createUsagePipeline({ classify: 1_000, analyze: 2_000, write: 3_000 });
  const filler = createClaudeFiller({ llm: fill.llm });
  const created = createDependencies(
    {
      pipeline,
      filler,
      fetchCommit: async ({ sha }) => {
        githubCalls += 1;
        return commit(sha, 'x');
      },
    },
    undefined,
    options.reservation,
  );
  created.dependencies.jobs.loadContext = async () => options.context ?? BLANK_CONTEXT;
  return { ...created, filler, calls: fill.calls, stages, githubCalls: () => githubCalls };
};

describe('runJob (빈칸 채우기)', () => {
  it('Claude 를 한 번 불러 다듬은 문단을 저장하고, 사용량과 예상량을 기록한다', async () => {
    const { dependencies, state, signals, calls, stages, githubCalls, filler } = createFillDependencies();
    state.latestAnalysis = STORED;

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.equal(calls.length, 1);
    assert.deepEqual(stages, []);
    assert.equal(githubCalls(), 0);
    assert.equal(state.status, 'completed');
    assert.equal(state.result, '첫 화면이 3초 정도 걸렸다.');
    assert.equal(state.usedTokens, 700);
    assert.equal(
      state.estimatedTokens,
      filler.estimate({ context: BLANK_CONTEXT, blank: BLANK_CONTEXT.blank!, analysis: STORED, onUsage: async () => {} }),
    );
    // 저장한 분석과 답이 프롬프트에 들어간다
    assert.ok(calls[0].user.includes('<fact>이미지를 모두 먼저 불러왔다</fact>'));
    assert.ok(calls[0].user.includes('<answer>\n3초 정도 걸렸다\n</answer>'));
    // 중간 단계 없이 시작(0) → 완료(3)
    assert.deepEqual(
      signals.map(({ status, step }) => `${status}:${step}`),
      ['running:0', 'completed:3'],
    );
    // 빈칸 채우기는 분석을 저장하지 않는다
    assert.equal(state.analysis, null);
  });

  it('저장한 분석이 없어도 본문과 답만으로 완료한다', async () => {
    const { dependencies, state, calls } = createFillDependencies();

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].user.includes('<analysis>'));
    assert.equal(state.status, 'completed');
  });

  it('할당량을 넘으면 Claude 호출 없이 quota_exceeded, 사용량 0', async () => {
    const { dependencies, state, signals, calls } = createFillDependencies({ reservation: 'exceeded' });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(calls.length, 0);
    assert.equal(state.errorCode, 'quota_exceeded');
    assert.ok((state.estimatedTokens ?? 0) > 0);
    assert.equal(state.usedTokens, 0);
    assert.equal(signals.at(-1)?.status, 'failed');
  });

  it('정책이 없으면 Claude 호출 없이 internal', async () => {
    const { dependencies, state, calls } = createFillDependencies({ reservation: 'no_plan' });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(calls.length, 0);
    assert.equal(state.errorCode, 'internal');
  });

  it('빈칸 값이 없는 빈칸 채우기 작업은 Claude 호출 없이 internal', async () => {
    const { dependencies, state, calls } = createFillDependencies({
      context: { ...BLANK_CONTEXT, blank: undefined },
    });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(calls.length, 0);
    assert.equal(state.errorCode, 'internal');
    assert.equal(state.estimatedTokens, null);
  });

  it('정리 후 남는 글이 없으면 invalid_result, 쓴 사용량은 남는다', async () => {
    const { dependencies, state, calls } = createFillDependencies({ markdown: '# 제목만' });

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(calls.length, 1);
    assert.equal(state.errorCode, 'invalid_result');
    assert.equal(state.usedTokens, 700);
  });

  it('남은 시간이 부족하면 Claude 를 부르지 않고 timeout', async () => {
    const { dependencies, state, calls } = createFillDependencies();
    dependencies.remainingTimeMs = () => MIN_REMAINING_MS - 1;

    assert.equal(await runJob('job-1', dependencies), 'failed');
    assert.equal(calls.length, 0);
    assert.equal(state.errorCode, 'timeout');
  });
});

describe('runJob (분석 저장)', () => {
  // 분석 단계에서 저장할 분석을 넘기는 파이프라인
  const analysisPipeline = (): Pipeline => ({
    prepare: async () => ({}),
    estimate: () => 1,
    classify: async () => ({}),
    analyze: async ({ onAnalysis }) => {
      await onAnalysis?.(STORED);
    },
    write: async () => '# 결과',
    review: async (_input, written) => written as string,
  });

  it('초안 작성 작업은 분석 단계 뒤 분석을 저장한다', async () => {
    const { dependencies, state } = createDependencies({ pipeline: analysisPipeline() });

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.deepEqual(state.analysis, STORED);
  });

  it('분석 저장에 실패해도 작업은 완료된다 (빈칸 채우기는 분석 없이도 동작)', async () => {
    const reported: unknown[] = [];
    const { dependencies, state } = createDependencies({
      pipeline: analysisPipeline(),
      reportError: (error) => reported.push(error),
    });
    dependencies.jobs.saveAnalysis = async () => {
      throw new Error('db down');
    };

    assert.equal(await runJob('job-1', dependencies), 'completed');
    assert.equal(state.status, 'completed');
    assert.equal(reported.length, 1);
  });
});
