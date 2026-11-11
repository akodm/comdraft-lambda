import type Anthropic from '@anthropic-ai/sdk';
import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts';
import type { Context } from 'aws-lambda';
import { createBroadcaster } from './broadcast.ts';
import { loadConfig, type LambdaConfig } from './config.ts';
import { parseGenerationRequest } from './contract.ts';
import { getDatabase } from './db.ts';
import { createCommitFetcher } from './github.ts';
import { createClaudeFiller } from './fill.ts';
import { createJobStore } from './jobs.ts';
import { createLinkFetch, fetchReferenceLinks } from './generation/links.ts';
import { createAnthropicClient } from './generation/anthropic-client.ts';
import { createAnthropicLlm } from './generation/llm.ts';
import { createClaudePipeline } from './pipeline.ts';
import { runJob, type RunJobOutcome } from './run-job.ts';

// 같은 실행 환경(웜 스타트)에서는 클라이언트를 재사용해 교환한 Anthropic 토큰을 캐시로 씀
let anthropicClient: Anthropic | null = null;

const getAnthropicClient = (config: LambdaConfig) => {
  if (!anthropicClient) {
    // GetWebIdentityToken 은 리전 STS 엔드포인트에서만 제공됨
    const sts = new STSClient({ region: config.awsRegion });

    anthropicClient = createAnthropicClient(config.federation, async (request) => {
      const output = await sts.send(new GetWebIdentityTokenCommand(request));
      return output.WebIdentityToken;
    });
  }

  return anthropicClient;
};

/**
 * API Gateway(REST, IAM 인증)가 비동기(Event)로 호출하는 진입점
 * - 요청 본문: { jobId, githubToken } (API Gateway 매핑 템플릿이 본문을 그대로 이벤트로 전달)
 * - 작업 종류(초안 작성 / 빈칸 채우기)는 jobId 로 DB 에서 읽어 나눔
 * - 비동기 호출이라 반환값은 호출한 쪽에 전달되지 않음 (결과는 DB 와 Realtime 신호로 알림)
 * - 토큰과 요청 내용은 로그로 남기지 않음 (CloudWatch Logs 미사용)
 */
export const handler = async (
  event: unknown,
  context: Context,
): Promise<{ outcome: RunJobOutcome | 'invalid_request' }> => {
  const request = parseGenerationRequest(event);

  if (!request) {
    return { outcome: 'invalid_request' };
  }

  const config = loadConfig();
  const sql = getDatabase(config.databaseUrl);

  // Anthropic 인증은 API 키 없이 Lambda 실행 역할로 연동 (Workload Identity Federation)
  const client = getAnthropicClient(config);
  // 링크 요청 함수는 호출마다 한 번만 만든다
  const linkFetch = createLinkFetch();
  const remainingTimeMs = () => context.getRemainingTimeInMillis();
  const llm = createAnthropicLlm(client, { remainingTimeMs });

  const outcome = await runJob(request.jobId, {
    jobs: createJobStore(sql),
    signal: createBroadcaster({
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.supabasePublishableKey,
    }),
    fetchCommit: createCommitFetcher(request.githubToken),
    pipeline: createClaudePipeline({
      llm,
      fetchLinks: (urls) => fetchReferenceLinks(urls, linkFetch),
      remainingTimeMs,
    }),
    // 빈칸 채우기 작업은 GitHub 토큰을 쓰지 않는다
    filler: createClaudeFiller({ llm }),
    remainingTimeMs,
  });

  return { outcome };
};
