import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containsSecret, isSecretFile } from './secrets.ts';

describe('secrets', () => {
  it('토큰과 키 패턴을 찾는다', () => {
    for (const s of [
      'AKIAABCDEFGHIJKLMNOP',
      'ghp_' + 'a'.repeat(36),
      'github_pat_' + 'a'.repeat(40),
      'xoxb-1-2-abc',
      'sk-' + 'a'.repeat(32),
      '-----BEGIN RSA PRIVATE KEY-----',
      'eyJhbGciOi.eyJzdWIiOi.abc_DEF-123',
      'api_key = "abcd1234efgh"',
    ]) {
      assert.equal(containsSecret(s), true, s);
    }
    assert.equal(containsSecret('const token = getToken();'), false);
  });

  it('비밀 파일 이름', () => {
    assert.equal(isSecretFile('.env.production'), true);
    assert.equal(isSecretFile('certs/server.pem'), true);
    assert.equal(isSecretFile('keys/id_rsa.pub'), true);
    assert.equal(isSecretFile('a/private.key'), true);
    assert.equal(isSecretFile('src/env.ts'), false);
  });
});
