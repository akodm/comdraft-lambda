import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assemble } from './assemble.ts';
import { GenerationFailure } from '../errors.ts';
import type { PreparedCommit, PreparedHunk } from './prepare.ts';
import type { PreparedLink } from './links.ts';
import type { Analysis } from './schemas.ts';

const hunk = (id: string, lines: string[], overrides: Partial<PreparedHunk> = {}): PreparedHunk => ({
  id,
  header: '@@ -1,2 +1,2 @@',
  lines,
  redacted: false,
  language: 'ts',
  ...overrides,
});

const baseHunk = hunk('C1.F1.H1', [' a', '-b', '+c']);

const commits: PreparedCommit[] = [
  {
    id: 'C1',
    sha: 'a1b2c3d4e5f6',
    htmlUrl: 'https://github.com/o/r/commit/a1b2c3d4e5f6',
    message: 'feat: add parser',
    files: [
      { id: 'C1.F1', filename: 'src/parser.ts', status: 'modified', additions: 1, deletions: 1, body: 'included', hunks: [baseHunk] },
    ],
  },
  {
    id: 'C2',
    sha: 'ffeeddccbbaa',
    htmlUrl: 'https://github.com/o/r/commit/ffeeddccbbaa',
    message: 'fix: edge case',
    files: [],
  },
];

const links: PreparedLink[] = [
  { id: 'L1', url: 'https://example.com/post', title: '좋은 글 [1]', text: 'body mentions useThing here' },
  { id: 'L2', url: 'https://other.dev/x', title: '', text: 'x' },
];

const analysis: Analysis = {
  facts: [],
  code: [
    { id: 'S1', section: 0, from: 'C1.F1.H1', startLine: 1, endLine: 3, mode: 'after', point: 'p' },
    { id: 'S2', section: 0, from: 'C1.F1.H1', startLine: 1, endLine: 3, mode: 'diff', point: 'p' },
  ],
  unknowns: [{ id: 'U1', section: 0, kind: 'motivation', ask: '왜 "이걸" {했나}' }],
};

const run = (markdown: string, overrides: Partial<Parameters<typeof assemble>[0]> = {}): string =>
  assemble({
    markdown,
    analysis,
    commits,
    hunks: new Map([[baseHunk.id, baseHunk]]),
    links,
    request: 'please mention requestWord',
    referencesHeading: '참고',
    ...overrides,
  });

describe('assemble', () => {
  it('{{code:S1}} 을 after 모드 원문 줄로 바꾸고 언어를 붙인다', () => {
    assert.equal(run('# 제목\n\n본문\n\n{{code:S1}}'), '# 제목\n\n본문\n\n```ts\na\nc\n```');
  });

  it('diff 모드는 접두사를 두고 언어 diff', () => {
    assert.equal(run('# 제목\n\n본문\n\n{{code:S2}}'), '# 제목\n\n본문\n\n```diff\n a\n-b\n+c\n```');
  });

  it('{{ code:S1 }} 처럼 공백이 있어도 치환한다', () => {
    assert.match(run('# 제목\n\n본문\n\n{{ code : S1 }}'), /```ts\na\nc\n```/);
  });

  it('코드 안에 백틱 울타리가 있어도 더 긴 울타리를 쓴다', () => {
    const h = hunk('C1.F1.H1', ['+```', '+x', '+```']);
    const out = run('# 제목\n\n본문\n\n{{code:S1}}', { hunks: new Map([[h.id, h]]) });
    assert.match(out, /````ts\n```\nx\n```\n````/);
  });

  it('문장 중간의 {{code:S1}} 과 {{ask:U1}} 은 독립 블록으로 뺀다', () => {
    assert.equal(
      run('# 제목\n\n설명 {{code:S1}} 계속 {{ask:U1}} 끝'),
      '# 제목\n\n설명\n\n```ts\na\nc\n```\n\n계속\n\n:::blank {kind="motivation" hint="왜 이걸 했나"}\n:::\n\n끝',
    );
  });

  it('{{commit:C2}} → [a1b2c3d](url), {{link:L1}} → [제목](url)', () => {
    const out = run('# 제목\n\n{{commit:C1}} 와 {{link:L1}} 참고');
    assert.ok(out.includes('[a1b2c3d](https://github.com/o/r/commit/a1b2c3d4e5f6) 와 [좋은 글 \\[1\\]](https://example.com/post) 참고'));
  });

  it('제목이 비면 호스트 이름을 링크 글자로 쓴다', () => {
    assert.ok(run('# 제목\n\n{{link:L2}}').includes('[other.dev](https://other.dev/x)'));
  });

  it('모르는 자리표시자는 지우지만 {{ value }} 같은 다른 글자는 그대로 둔다', () => {
    const out = run('# 제목\n\n앞 {{code:S9}} {{link:L9}} {{commit:C9}} {{ask:U9}} 뒤 {{ value }} {{code}}');
    assert.equal(out, '# 제목\n\n앞     뒤 {{ value }} {{code}}');
  });

  it('모델이 쓴 코드 블록·Markdown 링크·맨 URL·HTML 태그를 제거한다 (링크는 글자만)', () => {
    const md = [
      '# 제목',
      '',
      '```js',
      'evil()',
      '```',
      '',
      '~~~',
      'evil2',
      '~~~',
      '',
      '[글자](https://x.com/a) 와 ![그림](https://x.com/i.png) 와 <https://auto.com> 와 https://bare.com/p 끝',
      '',
      '<b>굵게</b> <script>x</script>',
      '',
      '[ref]: https://ref.com',
      '',
      '[참조][ref] 링크',
    ].join('\n');
    const out = run(md);
    assert.ok(!/evil|https?:|<b>|<script>|\]:/.test(out), out);
    assert.ok(out.includes('글자 와'));
    assert.ok(out.includes('굵게 x'));
    assert.ok(out.includes('참조 링크'));
    assert.ok(!out.includes('그림'));
  });

  it('닫히지 않은 코드 블록은 끝까지 제거한다', () => {
    const out = run('# 제목\n\n본문\n\n```\nevil');
    assert.equal(out, '# 제목\n\n본문');
  });

  it('인라인 코드 안의 URL 은 건드리지 않는다', () => {
    const out = run('# 제목\n\n`https://a.com` 은 요청에 없다', { request: 'https://a.com' });
    assert.ok(out.includes('`https://a.com`'));
  });

  it('근거에 없는 인라인 코드는 백틱을 벗긴다', () => {
    const out = run('# 제목\n\n`fooBar` `a` `src/parser.ts` `useThing` `requestWord` `feat: add parser`');
    assert.equal(out, '# 제목\n\nfooBar `a` `src/parser.ts` `useThing` `requestWord` `feat: add parser`');
  });

  it('벗겨진 인라인 코드 안의 HTML 도 제거한다', () => {
    assert.equal(run('# 제목\n\n본문 `<img src=x>` 끝'), '# 제목\n\n본문  끝');
  });

  it('비밀값이 든 코드 조각은 넣지 않는다', () => {
    const h = hunk('C1.F1.H1', ['+const k = "ghp_' + 'a'.repeat(36) + '";']);
    const out = run('# 제목\n\n본문\n\n{{code:S1}}', { hunks: new Map([[h.id, h]]) });
    assert.equal(out, '# 제목\n\n본문');
  });

  it('가린 hunk 나 없는 hunk 의 코드는 넣지 않는다', () => {
    const h = hunk('C1.F1.H1', ['+x'], { redacted: true });
    assert.equal(run('# 제목\n\n본문\n\n{{code:S1}}', { hunks: new Map([[h.id, h]]) }), '# 제목\n\n본문');
    assert.equal(run('# 제목\n\n본문\n\n{{code:S1}}', { hunks: new Map() }), '# 제목\n\n본문');
  });

  it('인용한 링크가 있으면 글 끝에 참고 절을 붙인다', () => {
    const out = run('# 제목\n\n{{link:L2}} 그리고 {{link:L1}} 와 {{link:L1}}');
    assert.ok(
      out.endsWith(
        '\n\n## 참고\n\n- [좋은 글 \\[1\\]](https://example.com/post)\n- [other.dev](https://other.dev/x)',
      ),
      out,
    );
  });

  it('인용하지 않으면 참고 절이 없다', () => {
    assert.ok(!run('# 제목\n\n본문').includes('참고'));
  });

  it('H1 이 여러 개면 두 번째부터 H2', () => {
    assert.equal(run('# 제목\n\n# 둘째\n\n본문\n\n#   셋째'), '# 제목\n\n## 둘째\n\n본문\n\n##   셋째');
  });

  it('첫 블록이 H1 이 아니거나 본문이 비면 invalid_result', () => {
    for (const md of ['본문만', '## 제목\n\n본문', '', '{{ask:U1}}\n\n# 제목\n\n본문', '# 제목', '# 제목\n\n  \n', '# 제목\n\n{{code:S9}}']) {
      assert.throws(
        () => run(md),
        (e: unknown) => e instanceof GenerationFailure && e.code === 'invalid_result' && e.message === 'invalid_result',
        md,
      );
    }
  });
});
