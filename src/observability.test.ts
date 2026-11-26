import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ErrorEvent } from '@sentry/node';
import { scrubBreadcrumb, scrubEvent, scrubMessage } from './observability.ts';

describe('scrubMessage', () => {
  it('GitHub 토큰, 키, Bearer 값, 접속 정보를 가린다', () => {
    const masked = scrubMessage(
      'ghu_abcdefghijklmnopqrstuvwxyz0123 sk-ant-api03-abcdefghijklmnopqrstuvwx Bearer abcdef1234567890xyz postgresql://u:pw-secret@host:6543/db',
    );

    assert.ok(!masked.includes('ghu_abcdefghijklmnopqrstuvwxyz0123'));
    assert.ok(!masked.includes('sk-ant-api03'));
    assert.ok(!masked.includes('abcdef1234567890xyz'));
    assert.ok(!masked.includes('pw-secret'));
    assert.ok(masked.includes('host:6543'));
  });

  it('긴 메시지는 500자로 자른다', () => {
    assert.equal(scrubMessage('a'.repeat(900)).length, 501);
  });
});

describe('scrubBreadcrumb', () => {
  it('콘솔 기록은 버리고 주소의 쿼리를 지운다', () => {
    assert.equal(scrubBreadcrumb({ category: 'console', message: 'x' }), null);
    assert.deepEqual(
      scrubBreadcrumb({ category: 'http', data: { url: 'https://example.com/a?token=1', method: 'GET' } }),
      { category: 'http', data: { url: 'https://example.com/a', method: 'GET' } },
    );
  });
});

describe('scrubEvent', () => {
  it('요청·사용자·extra 를 지우고 예외 메시지를 가린다', () => {
    const event = scrubEvent({
      type: undefined,
      request: { url: 'https://x', data: '{"githubToken":"ghu_x"}' },
      user: { id: '1', ip_address: '1.2.3.4' },
      extra: { body: 'code' },
      exception: { values: [{ type: 'Error', value: 'bad ghp_abcdefghijklmnopqrstuvwxyz012345' }] },
    } as ErrorEvent);

    assert.equal(event.request, undefined);
    assert.equal(event.user, undefined);
    assert.equal(event.extra, undefined);
    assert.equal(event.exception?.values?.[0].value, 'bad [redacted]');
  });
});
