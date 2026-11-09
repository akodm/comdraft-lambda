import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from './config.ts';

const BASE_ENV = {
  DATABASE_URL: 'x',
  SUPABASE_URL: 'x',
  SUPABASE_PUBLISHABLE_KEY: 'x',
};

describe('loadConfig', () => {
  it('ANTHROPIC_API_KEY 가 없으면 실패한다', () => {
    assert.throws(() => loadConfig(BASE_ENV), /ANTHROPIC_API_KEY/);
  });

  it('ANTHROPIC_API_KEY 를 설정값으로 읽는다', () => {
    const config = loadConfig({ ...BASE_ENV, ANTHROPIC_API_KEY: 'test-key' });

    assert.equal(config.anthropicApiKey, 'test-key');
  });
});
