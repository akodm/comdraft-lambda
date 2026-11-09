import type { Context } from 'aws-lambda';
import { createBroadcaster } from './broadcast.ts';
import { loadConfig } from './config.ts';
import { parseGenerationRequest } from './contract.ts';
import { getDatabase } from './db.ts';
import { createCommitFetcher } from './github.ts';
import { createJobStore } from './jobs.ts';
import { createPlaceholderPipeline } from './pipeline.ts';
import { runJob, type RunJobOutcome } from './run-job.ts';

/**
 * API Gateway(REST, IAM 인증)가 비동기(Event)로 호출하는 진입점
 * - 요청 본문: { jobId, githubToken } (API Gateway 매핑 템플릿이 본문을 그대로 이벤트로 전달)
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

  const outcome = await runJob(request.jobId, {
    jobs: createJobStore(sql),
    signal: createBroadcaster({
      supabaseUrl: config.supabaseUrl,
      publishableKey: config.supabasePublishableKey,
    }),
    fetchCommit: createCommitFetcher(request.githubToken),
    pipeline: createPlaceholderPipeline(),
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
  });

  return { outcome };
};
