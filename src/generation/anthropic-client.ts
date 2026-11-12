import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import type { FederationConfig } from '../config.ts';
import { LLM_TIMEOUT_MS_BY_MODEL } from './llm.ts';

/**
 * Anthropic 클라이언트 (Workload Identity Federation)
 * - API 키 없이 Lambda 실행 역할로 AWS STS 에서 받은 JWT 를 Anthropic 단기 토큰으로 교환
 * - SDK 가 토큰을 캐시하고 만료 전에 다시 교환 (교환마다 새 JWT 를 받아야 jti 재사용 오류가 나지 않음)
 */

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

// Anthropic 연동 규칙(federation rule)의 audience 와 같은 값
export const ANTHROPIC_AUDIENCE = 'https://api.anthropic.com';

// STS 토큰 수명 (교환 직후에만 쓰므로 짧게)
export const STS_TOKEN_DURATION_SECONDS = 900;

export interface StsTokenRequest {
  Audience: string[];
  SigningAlgorithm: string;
  DurationSeconds: number;
}

// STS GetWebIdentityToken 호출 (테스트에서는 가짜로 대체)
export type RequestStsToken = (request: StsTokenRequest) => Promise<string | undefined>;

export const createStsIdentityTokenProvider = (requestToken: RequestStsToken) => {
  return async (): Promise<string> => {
    const token = await requestToken({
      Audience: [ANTHROPIC_AUDIENCE],
      SigningAlgorithm: 'RS256',
      DurationSeconds: STS_TOKEN_DURATION_SECONDS,
    });

    if (!token) {
      throw new Error('STS 가 웹 ID 토큰을 반환하지 않았습니다.');
    }

    return token;
  };
};

export const createAnthropicClient = (
  federation: FederationConfig,
  requestToken: RequestStsToken,
): Anthropic =>
  new Anthropic({
    credentials: oidcFederationProvider({
      identityTokenProvider: createStsIdentityTokenProvider(requestToken),
      federationRuleId: federation.federationRuleId,
      organizationId: federation.organizationId,
      serviceAccountId: federation.serviceAccountId,
      workspaceId: federation.workspaceId,
      baseURL: ANTHROPIC_BASE_URL,
      fetch,
    }),
    // 호출마다 모델별 제한 시간을 따로 넘기므로, 기본값은 가장 긴 쪽으로 둔다
    timeout: Math.max(...Object.values(LLM_TIMEOUT_MS_BY_MODEL)),
    // 재시도는 남은 실행 시간을 아는 createAnthropicLlm 이 직접 함
    maxRetries: 0,
  });
