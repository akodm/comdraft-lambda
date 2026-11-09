import assert from 'node:assert/strict';
import type dns from 'node:dns';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import {
  LINK_MAX_BYTES,
  LINK_MAX_REDIRECTS,
  LINK_TITLE_MAX,
  LINK_TOKEN_BUDGET,
  MAX_REFERENCE_LINKS,
  estimateTokens,
} from './limits.ts';
import {
  type LinkFetch,
  createLinkFetch,
  createSafeLookup,
  extractReadableText,
  fetchReferenceLinks,
  isAllowedUrl,
  isPublicAddress,
} from './links.ts';

const html = (body: string, title = 'Title') =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

const article = (sentence = '본문 문장입니다.') =>
  html(`<article><h1>Heading</h1>${`<p>${sentence} `.repeat(30)}</p></article>`);

const htmlResponse = (body: string, type = 'text/html; charset=utf-8') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });

const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

const fetchFrom =
  (routes: Record<string, () => Response>): LinkFetch =>
  async (url) => {
    const route = routes[url];
    if (!route) throw new Error('unexpected');
    return route();
  };

describe('isPublicAddress', () => {
  it('사설·루프백·링크 로컬·mapped 주소를 막는다', () => {
    for (const a of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1', '255.255.255.255',
      'ff02::1', 'not-an-ip',
      '::7f00:1', '::127.0.0.1', '::ffff:0:7f00:1', '64:ff9b:1::a00:1', '2002:7f00:1::', '2002:a00:1::1', '2001::1',
    ]) {
      assert.equal(isPublicAddress(a), false, a);
    }
  });

  it('공인 주소는 허용한다', () => {
    assert.equal(isPublicAddress('93.184.216.34'), true);
    assert.equal(isPublicAddress('2606:2800:220:1:248:1893:25c8:1946'), true);
    assert.equal(isPublicAddress('::ffff:93.184.216.34'), true);
  });
});

describe('isAllowedUrl', () => {
  it('자격 증명·비기본 포트·다른 프로토콜 URL 을 막는다', () => {
    assert.equal(isAllowedUrl(new URL('https://u:p@example.com')), false);
    assert.equal(isAllowedUrl(new URL('https://example.com:8443')), false);
    assert.equal(isAllowedUrl(new URL('ftp://example.com')), false);
  });

  it('http/https 기본 포트는 허용한다', () => {
    assert.equal(isAllowedUrl(new URL('https://example.com/a')), true);
    assert.equal(isAllowedUrl(new URL('http://example.com:80/a')), true);
    assert.equal(isAllowedUrl(new URL('https://example.com:443/a')), true);
  });

  it('공인이 아닌 IP 리터럴 호스트를 막는다', () => {
    assert.equal(isAllowedUrl(new URL('http://127.0.0.1/')), false);
    assert.equal(isAllowedUrl(new URL('http://2130706433/')), false);
    assert.equal(isAllowedUrl(new URL('http://[::1]/')), false);
    assert.equal(isAllowedUrl(new URL('http://[::ffff:10.0.0.1]/')), false);
    assert.equal(isAllowedUrl(new URL('http://[::7f00:1]/')), false);
    assert.equal(isAllowedUrl(new URL('http://93.184.216.34/')), true);
  });
});

describe('createSafeLookup', () => {
  const fakeResolve =
    (addresses: { address: string; family: number }[], error?: Error) =>
    ((_host: string, _opts: unknown, cb: (...args: unknown[]) => void) => {
      if (error) cb(error);
      else cb(null, addresses);
    }) as unknown as typeof dns.lookup;

  const run = (resolve: typeof dns.lookup, options: object) =>
    new Promise<{ err: Error | null; result: unknown; family?: unknown }>((done) => {
      createSafeLookup(resolve)('example.com', options, ((err: Error | null, result: unknown, family?: unknown) =>
        done({ err, result, family })) as never);
    });

  it('사설 주소로 풀리면 오류를 낸다', async () => {
    const { err } = await run(fakeResolve([{ address: '10.0.0.5', family: 4 }]), { all: true });
    assert.ok(err);
  });

  it('하나라도 공인이 아니면 오류를 낸다', async () => {
    const { err } = await run(
      fakeResolve([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
      { all: true },
    );
    assert.ok(err);
  });

  it('all 옵션이면 주소 배열을 돌려준다', async () => {
    const list = [{ address: '93.184.216.34', family: 4 }];
    const { err, result } = await run(fakeResolve(list), { all: true });
    assert.equal(err, null);
    assert.deepEqual(result, list);
  });

  it('all 이 아니면 첫 주소와 family 를 돌려준다', async () => {
    const { err, result, family } = await run(fakeResolve([{ address: '93.184.216.34', family: 4 }]), {});
    assert.equal(err, null);
    assert.equal(result, '93.184.216.34');
    assert.equal(family, 4);
  });

  it('해석 오류와 빈 결과는 오류로 전달한다', async () => {
    assert.ok((await run(fakeResolve([], new Error('ENOTFOUND')), { all: true })).err);
    assert.ok((await run(fakeResolve([]), { all: true })).err);
  });
});

describe('createLinkFetch', () => {
  it('localhost 로 가는 요청은 안전한 lookup 이 막는다', async () => {
    const server = createServer((_req, res) => res.end('secret'));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const { port } = server.address() as { port: number };
      await assert.rejects(
        createLinkFetch()(`http://localhost:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});

describe('extractReadableText', () => {
  it('본문과 제목을 뽑는다', () => {
    const { title, text } = extractReadableText(article(), 'https://example.com/a');
    assert.ok(title.length > 0);
    assert.match(text, /본문 문장입니다/);
    assert.doesNotMatch(text, /<p>/);
  });

  it('readability 가 실패하면 body 텍스트를 쓴다', () => {
    const { text } = extractReadableText(html('<div>짧은 글</div>'), 'https://example.com/');
    assert.match(text, /짧은 글/);
  });
});

describe('fetchReferenceLinks', () => {
  it('사설 주소로 가는 리다이렉트는 따라가지 않고 그 링크를 뺀다', async () => {
    const calls: string[] = [];
    const fetchImpl: LinkFetch = async (url) => {
      calls.push(url);
      return redirect('http://127.0.0.1/');
    };
    assert.deepEqual(await fetchReferenceLinks(['https://example.com/a'], fetchImpl), []);
    assert.deepEqual(calls, ['https://example.com/a']);
  });

  it('사설 주소 URL 은 요청하지 않는다', async () => {
    let called = 0;
    const fetchImpl: LinkFetch = async () => {
      called += 1;
      return htmlResponse(article());
    };
    assert.deepEqual(await fetchReferenceLinks(['http://169.254.169.254/latest', 'not a url'], fetchImpl), []);
    assert.equal(called, 0);
  });

  it('리다이렉트는 3회까지 따라간다', async () => {
    assert.equal(LINK_MAX_REDIRECTS, 3);
    const ok = fetchFrom({
      'https://a.test/0': () => redirect('/1', 301),
      'https://a.test/1': () => redirect('/2', 307),
      'https://a.test/2': () => redirect('https://a.test/3', 308),
      'https://a.test/3': () => htmlResponse(article()),
    });
    const result = await fetchReferenceLinks(['https://a.test/0'], ok);
    assert.equal(result.length, 1);
    assert.equal(result[0].url, 'https://a.test/0');

    const tooMany = fetchFrom({
      'https://a.test/0': () => redirect('/1'),
      'https://a.test/1': () => redirect('/2'),
      'https://a.test/2': () => redirect('/3'),
      'https://a.test/3': () => redirect('/4'),
      'https://a.test/4': () => htmlResponse(article()),
    });
    assert.deepEqual(await fetchReferenceLinks(['https://a.test/0'], tooMany), []);
  });

  it('html 이 아니거나 본문이 비면 뺀다, 나머지는 L1 부터 다시 번호', async () => {
    const fetchImpl = fetchFrom({
      'https://a.test/img': () => htmlResponse('x', 'image/png'),
      'https://a.test/empty': () => htmlResponse(html('')),
      'https://a.test/404': () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } }),
      'https://a.test/304': () => new Response(null, { status: 304 }),
      'https://a.test/ok': () => htmlResponse(article()),
      'https://a.test/md': () => htmlResponse('# 제목\n\n마크다운 본문', 'text/markdown'),
    });
    const result = await fetchReferenceLinks(
      ['https://a.test/img', 'https://a.test/empty', 'https://a.test/404', 'https://a.test/304', 'https://a.test/ok', 'https://a.test/md'],
      fetchImpl,
    );
    assert.deepEqual(result.map((l) => [l.id, l.url]), [
      ['L1', 'https://a.test/ok'],
      ['L2', 'https://a.test/md'],
    ]);
    assert.match(result[1].text, /마크다운 본문/);
    assert.equal(result[1].title, 'a.test');
  });

  it('예외를 던지는 fetch 도 그 링크만 뺀다', async () => {
    const fetchImpl: LinkFetch = async (url) => {
      if (url.endsWith('/boom')) throw new Error('network');
      return htmlResponse(article());
    };
    const result = await fetchReferenceLinks(['https://a.test/boom', 'https://a.test/ok'], fetchImpl);
    assert.deepEqual(result.map((l) => [l.id, l.url]), [['L1', 'https://a.test/ok']]);
  });

  it('앞의 10개 URL 만 시도한다', async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `https://a.test/${i}`);
    const seen: string[] = [];
    const fetchImpl: LinkFetch = async (url) => {
      seen.push(url);
      return htmlResponse(article());
    };
    const result = await fetchReferenceLinks(urls, fetchImpl);
    assert.equal(MAX_REFERENCE_LINKS, 10);
    assert.equal(seen.length, 10);
    assert.equal(result.length, 10);
    assert.equal(result[9].id, 'L10');
  });

  it('제목은 80자, 비면 호스트 이름', async () => {
    const long = 'T'.repeat(200);
    const fetchImpl = fetchFrom({
      'https://a.test/long': () => htmlResponse(html('<p>본문</p>', long)),
      'https://a.test/none': () => htmlResponse('<html><body><p>본문</p></body></html>'),
    });
    const [a, b] = await fetchReferenceLinks(['https://a.test/long', 'https://a.test/none'], fetchImpl);
    assert.equal(LINK_TITLE_MAX, 80);
    assert.ok(a.title.length <= 80 && a.title.startsWith('TTTT'));
    assert.equal(b.title, 'a.test');
  });

  it('제목을 자를 때 이모지 쌍을 쪼개지 않는다', async () => {
    const title = `${'T'.repeat(79)}😀 tail`;
    const fetchImpl = fetchFrom({ 'https://a.test/e': () => htmlResponse(html('<p>본문</p>', title)) });
    const [link] = await fetchReferenceLinks(['https://a.test/e'], fetchImpl);
    assert.equal(link.title, 'T'.repeat(79));
  });

  it('본문은 링크당 토큰 상한까지만 남긴다', async () => {
    const big = '가'.repeat(20_000);
    const fetchImpl = fetchFrom({ 'https://a.test/big': () => htmlResponse(`<html><body><p>${big}</p></body></html>`) });
    const [link] = await fetchReferenceLinks(['https://a.test/big'], fetchImpl);
    assert.ok(estimateTokens(link.text) <= LINK_TOKEN_BUDGET);
    assert.ok(estimateTokens(link.text) > LINK_TOKEN_BUDGET - 10);
  });

  it('응답은 최대 바이트까지만 읽고 나머지는 취소한다', async () => {
    let cancelled = false;
    const chunk = new TextEncoder().encode('a'.repeat(512 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: LinkFetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/plain' } });
    const [link] = await fetchReferenceLinks(['https://a.test/stream'], fetchImpl);
    assert.ok(link);
    assert.ok(cancelled);
    assert.ok(sent <= LINK_MAX_BYTES + chunk.length * 2);
  });
});
