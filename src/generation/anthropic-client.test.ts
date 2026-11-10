import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANTHROPIC_AUDIENCE,
  createStsIdentityTokenProvider,
  STS_TOKEN_DURATION_SECONDS,
  type StsTokenRequest,
} from './anthropic-client.ts';

describe('createStsIdentityTokenProvider', () => {
  it('Anthropic audience 와 RS256 으로 STS 토큰을 요청한다', async () => {
    const requests: StsTokenRequest[] = [];
    const provider = createStsIdentityTokenProvider(async (request) => {
      requests.push(request);
      return 'jwt-1';
    });

    assert.equal(await provider(), 'jwt-1');
    assert.deepEqual(requests, [
      {
        Audience: [ANTHROPIC_AUDIENCE],
        SigningAlgorithm: 'RS256',
        DurationSeconds: STS_TOKEN_DURATION_SECONDS,
      },
    ]);
    assert.equal(ANTHROPIC_AUDIENCE, 'https://api.anthropic.com');
  });

  it('토큰 교환마다 새 JWT 를 받는다 (jti 재사용 방지)', async () => {
    let count = 0;
    const provider = createStsIdentityTokenProvider(async () => `jwt-${++count}`);

    assert.equal(await provider(), 'jwt-1');
    assert.equal(await provider(), 'jwt-2');
  });

  it('STS 가 토큰을 주지 않으면 실패한다', async () => {
    const provider = createStsIdentityTokenProvider(async () => undefined);

    await assert.rejects(provider(), /STS/);
  });
});
