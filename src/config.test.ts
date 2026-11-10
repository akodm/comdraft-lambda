import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.ts';

const BASE_ENV = {
  DATABASE_URL: 'x',
  SUPABASE_URL: 'x',
  SUPABASE_PUBLISHABLE_KEY: 'x',
  AWS_REGION: 'ap-northeast-2',
  ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
  ANTHROPIC_ORGANIZATION_ID: '00000000-0000-0000-0000-000000000000',
  ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
};

describe('loadConfig', () => {
  for (const key of [
    'ANTHROPIC_FEDERATION_RULE_ID',
    'ANTHROPIC_ORGANIZATION_ID',
    'ANTHROPIC_SERVICE_ACCOUNT_ID',
    'AWS_REGION',
  ]) {
    it(`${key} 가 없으면 실패한다`, () => {
      const env: Record<string, string> = { ...BASE_ENV };
      delete env[key];

      assert.throws(() => loadConfig(env), new RegExp(key));
    });
  }

  it('연동 설정을 읽고, 워크스페이스는 선택값으로 둔다', () => {
    const config = loadConfig(BASE_ENV);

    assert.deepEqual(config.federation, {
      federationRuleId: 'fdrl_test',
      organizationId: '00000000-0000-0000-0000-000000000000',
      serviceAccountId: 'svac_test',
      workspaceId: undefined,
    });
    assert.equal(config.awsRegion, 'ap-northeast-2');

    const withWorkspace = loadConfig({ ...BASE_ENV, ANTHROPIC_WORKSPACE_ID: 'wrkspc_test' });

    assert.equal(withWorkspace.federation.workspaceId, 'wrkspc_test');
  });

  it('API 키 없이 동작한다 (ANTHROPIC_API_KEY 를 읽지 않음)', () => {
    const config = loadConfig(BASE_ENV);

    assert.equal('anthropicApiKey' in config, false);
  });
});
