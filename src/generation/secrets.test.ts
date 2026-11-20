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

  it('Stripe·Supabase·Slack·Discord·npm 등 추가 토큰 형식을 찾는다', () => {
    for (const s of [
      'sk_test_' + 'a'.repeat(24),
      'rk_test_' + 'a'.repeat(24),
      'whsec_' + 'a'.repeat(32),
      'sb_secret_' + 'a'.repeat(30),
      'sbp_' + 'a'.repeat(40),
      'https://hooks.slack.com/services/T000/B000/' + 'a'.repeat(24),
      'xoxa-2-' + 'a'.repeat(12),
      'xoxo-' + 'a'.repeat(12),
      'xoxs-' + 'a'.repeat(12),
      'https://discord.com/api/webhooks/123456/' + 'a'.repeat(30),
      'https://discordapp.com/api/webhooks/123456/' + 'a'.repeat(30),
      'npm_' + 'a'.repeat(36),
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----',
      '-----BEGIN EC PRIVATE KEY-----',
      '-----BEGIN DSA PRIVATE KEY-----',
    ]) {
      assert.equal(containsSecret(s), true, s);
      assert.equal(redactSecrets(s).includes('aaaaaa'), false, s);
    }
  });

  it('UUID, git SHA, base64 데이터는 비밀로 보지 않는다', () => {
    for (const s of [
      'id: 123e4567-e89b-12d3-a456-426614174000',
      'commit 9b59902c1f2e3d4a5b6c7d8e9f00112233445566',
      'const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";',
      'const sbp = computeSbpValue(1);',
      'https://hooks.example.com/services/abc',
      'npm_config_cache=1',
    ]) {
      assert.equal(containsSecret(s), false, s);
    }
  });

  it('추가 비밀 파일 이름', () => {
    for (const f of [
      'infra/terraform.tfvars',
      'prod.auto.tfvars.json',
      'terraform.tfstate',
      'terraform.tfstate.backup',
      '.npmrc',
      'apps/web/.NPMRC',
      '.netrc',
      '.pgpass',
      'credentials.json',
      'config/Credentials.json',
      'service-account.json',
      'service-account-prod.json',
      'certs/client.p12',
      'client.PFX',
      'release.keystore',
      'app/release.jks',
      'secrets.yml',
      'deploy/secrets.yaml',
      '.envrc',
    ]) {
      assert.equal(isSecretFile(f), true, f);
    }
    for (const f of [
      'terraform.tfvars.example',
      'main.tf',
      'credentials.ts',
      'service-account.ts',
      'docs/secrets.md',
      'src/npmrc.ts',
    ]) {
      assert.equal(isSecretFile(f), false, f);
    }
    // 기존 동작: .env 로 시작하면 템플릿(.env.example)도 이름만 남긴다
    assert.equal(isSecretFile('.env.example'), true);
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

  it('긴 입력에서도 검사가 선형 시간에 끝난다', () => {
    for (const text of [
      'a'.repeat(100_000),
      'token'.repeat(20_000),
      'ab+'.repeat(30_000),
      'password' + 'x'.repeat(100_000),
      'eyJ'.repeat(30_000),
    ]) {
      const started = performance.now();
      containsSecret(text);
      redactSecrets(text);
      assert.ok(performance.now() - started < 500, `${text.slice(0, 8)}… 가 너무 오래 걸림`);
    }
  });

  it('반복 길이를 묶어도 긴 실제 비밀값은 계속 잡는다', () => {
    assert.equal(containsSecret('api_key = "' + 'a'.repeat(300) + '"'), true);
    assert.equal(containsSecret('postgresql+psycopg://user:pass@db/x'), true);
    assert.equal(containsSecret('SUPER_LONG_SERVICE_SECRET_KEY_VALUE = "abcdefgh1234"'), true);
  });

  it('SSH 키 파일 이름 (rsa 외 형식)', () => {
    for (const name of ['id_ed25519', 'keys/id_ed25519.pub', 'id_ecdsa', 'id_ecdsa_sk', 'id_dsa', 'ID_RSA']) {
      assert.equal(isSecretFile(name), true, name);
    }
    assert.equal(isSecretFile('src/id_display.ts'), false);
  });
});
