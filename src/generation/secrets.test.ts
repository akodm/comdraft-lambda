import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containsSecret, isSecretFile, redactSecrets } from './secrets.ts';

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
    assert.equal(isSecretFile('SERVER.PEM'), true);
    assert.equal(isSecretFile('src/env.ts'), false);
  });

  it('흔한 키=값 형태를 찾는다', () => {
    for (const s of [
      '"password": "hunter2hunter2"',
      '{"apiKey": "abcd1234efgh5678"}',
      'password: hunter2hunter2',
      'password = `abcdefgh12`',
      'SECRET_KEY = "abcdefgh1234"',
      'PRIVATE_KEY=abcdefgh1234',
      'client_secret_value=abcdefgh1234',
    ]) {
      assert.equal(containsSecret(s), true, s);
    }
  });

  it('코드와 타입 표기는 비밀로 보지 않는다', () => {
    for (const s of [
      'const token = getToken();',
      'password: string;',
      'apiKey: process.env.API_KEY',
      'token: TokenResponseType;',
      '.risk-assessment-management-tool',
      'disk-usage-indicator-wrapper-x',
    ]) {
      assert.equal(containsSecret(s), false, s);
    }
  });

  it('추가 토큰 형식을 찾는다', () => {
    for (const s of [
      'gho_' + 'a'.repeat(30),
      'ghu_' + 'a'.repeat(30),
      'ghr_' + 'a'.repeat(30),
      'sk_live_' + 'a'.repeat(24),
      'rk_live_' + 'a'.repeat(24),
      'ASIAABCDEFGHIJKLMNOP',
      'AIza' + 'a'.repeat(35),
      'postgres://user:pass@host/db',
      'Authorization: Bearer ' + 'a'.repeat(24),
    ]) {
      assert.equal(containsSecret(s), true, s);
    }
  });

  it('redactSecrets 는 비밀 부분만 가린다', () => {
    assert.equal(
      redactSecrets('fix: key ghp_' + 'a'.repeat(36) + ' 제거, db postgres://u:p@h/x 도'),
      'fix: key [가림] 제거, db [가림]h/x 도',
    );
    assert.equal(redactSecrets('일반 메시지'), '일반 메시지');
  });

  it('PGP 개인 키, 빈 사용자 접속 문자열', () => {
    assert.equal(containsSecret('-----BEGIN PGP PRIVATE KEY BLOCK-----'), true);
    assert.equal(containsSecret('-----BEGIN OPENSSH PRIVATE KEY-----'), true);
    assert.equal(containsSecret('redis://:s3cretpass@cache.internal:6379'), true);
    assert.equal(containsSecret('postgres://user:pass@db'), true);
    assert.equal(containsSecret('see https://example.com/a:b'), false);
  });

  it('SSH 키 파일 이름 (rsa 외 형식)', () => {
    for (const name of ['id_ed25519', 'keys/id_ed25519.pub', 'id_ecdsa', 'id_ecdsa_sk', 'id_dsa', 'ID_RSA']) {
      assert.equal(isSecretFile(name), true, name);
    }
    assert.equal(isSecretFile('src/id_display.ts'), false);
  });
});
