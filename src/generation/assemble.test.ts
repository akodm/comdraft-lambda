import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Lexer, type Token } from 'marked';
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

// 조립 결과를 GFM 으로 읽어 코드 블록, HTML, 링크, 이미지, 정의가 우리가 넣은 것 말고는 없는지 확인한다.
const ALLOWED_HREFS = new Set(['https://ex.com/a', 'https://github.com/x', 'https://other.dev/x', 'https://example.com/post']);
const collectTokens = (tokens: Token[] | undefined, found: Token[]): void => {
  for (const token of tokens ?? []) {
    found.push(token);
    const any = token as unknown as {
      tokens?: Token[];
      items?: Token[];
      header?: { tokens: Token[] }[];
      rows?: { tokens: Token[] }[][];
    };
    collectTokens(any.tokens, found);
    collectTokens(any.items, found);
    any.header?.forEach((cell) => collectTokens(cell.tokens, found));
    any.rows?.forEach((row) => row.forEach((cell) => collectTokens(cell.tokens, found)));
  }
};
const CONTAINER_START = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*[ \t]*/;
const BLANK_BLOCK = /^:::blank \{kind="[a-z]+" hint="[^"\n]*"\}\n:::$/gm;
const assertNoInjectedMarkup = (markdown: string, allowedCodeBlocks = 0, allowedBlanks = 0): Token[] => {
  const found: Token[] = [];
  collectTokens(new Lexer({ gfm: true }).lex(markdown), found);
  let codeBlocks = 0;
  let rest = markdown;
  for (const token of found) {
    if (token.type === 'code') {
      codeBlocks += 1;
      rest = rest.replace(token.raw, '');
    } else if (token.type === 'link') {
      assert.ok(ALLOWED_HREFS.has((token as unknown as { href: string }).href), `link ${token.raw} in ${markdown}`);
    } else {
      assert.ok(!['html', 'image', 'def'].includes(token.type), `${token.type} ${token.raw} in ${markdown}`);
    }
  }
  assert.equal(codeBlocks, allowedCodeBlocks, `code blocks in ${markdown}`);
  assert.equal(rest.match(BLANK_BLOCK)?.length ?? 0, allowedBlanks, `blank blocks in ${markdown}`);
  rest = rest.replace(BLANK_BLOCK, '');
  for (const line of rest.split('\n')) {
    const start = line.replace(CONTAINER_START, '');
    // 한 줄 안에서 닫힌 ```x``` 는 울타리가 아니라 인라인 코드다.
    if (/^(```|~~~|:::)/.test(start) && !/^(`{3,})[^`]*\1(?!`)/.test(start)) {
      assert.fail(`block opener ${JSON.stringify(line)} in ${markdown}`);
    }
  }
  return found;
};

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

  it('{{link:L1}} → [제목](url)', () => {
    const out = run('# 제목\n\n{{link:L1}} 참고');
    assert.ok(out.includes('[좋은 글 \\[1\\]](https://example.com/post) 참고'));
  });

  it('{{commit:…}} 은 커밋 링크로 바꾸지 않고 지운다 (본문과 참고 절 모두 커밋 없음)', () => {
    const out = run('# 제목\n\n고쳤다 {{commit:C1}} 그리고 {{link:L1}} 와 {{commit:C2}}');
    assert.ok(!out.includes('{{'));
    assert.ok(!out.includes('github.com/o/r/commit'), out);
    assert.ok(!out.includes('a1b2c3d'), out);
    assert.ok(!out.includes('ffeeddc'), out);
    assert.ok(out.endsWith('\n\n## 참고\n\n- [좋은 글 \\[1\\]](https://example.com/post)'), out);
  });

  it('제목이 비면 호스트 이름을 링크 글자로 쓴다', () => {
    assert.ok(run('# 제목\n\n{{link:L2}}').includes('[other.dev](https://other.dev/x)'));
  });

  it('모르는 자리표시자는 지우지만 {{ value }} 같은 다른 글자는 그대로 둔다', () => {
    const out = run('# 제목\n\n앞 {{code:S9}} {{link:L9}} {{commit:C9}} {{ask:U9}} 뒤 {{ value }} {{code}}');
    assert.equal(out, '# 제목\n\n앞         뒤 {{ value }} {{code}}');
  });

  it('인라인 코드 안의 URL 은 건드리지 않는다', () => {
    const out = run('# 제목\n\n`https://a.com` 은 요청에 없다', { request: 'https://a.com' });
    assert.ok(out.includes('`https://a.com`'));
  });

  it('근거에 없는 인라인 코드는 백틱을 벗긴다', () => {
    const out = run('# 제목\n\n`fooBar` `a` `src/parser.ts` `useThing` `requestWord` `feat: add parser`');
    assert.equal(out, '# 제목\n\nfooBar `a` `src/parser.ts` `useThing` `requestWord` `feat: add parser`');
  });

  it('벗겨진 인라인 코드 안의 HTML 은 글자로 남고 태그가 되지 않는다', () => {
    assert.equal(run('# 제목\n\n본문 `<img src=x>` 끝'), '# 제목\n\n본문 \\<img src=x\\> 끝');
  });

  it('근거 있는 인라인 코드 안의 자리표시자는 치환하지 않는다', () => {
    const h = hunk('C1.F1.H1', [' a', '-b', '+c', '+{{link:L1}} {{code:S1}}']);
    const out = run('# 제목\n\n`{{link:L1}}` `{{code:S1}}`', { hunks: new Map([[h.id, h]]) });
    assert.equal(out, '# 제목\n\n`{{link:L1}}` `{{code:S1}}`');
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

  describe('모델 글 무력화', () => {
    const probeHunk = hunk('C1.F1.H1', [' a', '-b', '+c', '+<b>x</b>', '+<img src=x onerror=alert(1)>', '+```js']);
    const probeLinks: PreparedLink[] = [
      { id: 'L1', url: 'https://ex.com/a', title: '<img src=x onerror=alert(1)> *t* www.t.com', text: 'body www.grounded.com ">hi' },
    ];
    const probe = (value: string): string => {
      const out = run(`# T\n\nbody\n\n${value}`, {
        hunks: new Map([[probeHunk.id, probeHunk]]),
        links: probeLinks,
      });
      return out.slice('# T\n\nbody\n\n'.length);
    };
    const escaped = (text: string, index: number): boolean => {
      let n = 0;
      for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) n += 1;
      return n % 2 === 1;
    };
    // 이스케이프되지 않은 [ < 가 없고, GFM 으로 읽어도 주입된 마크업이 없어야 한다.
    const assertInert = (out: string, allowedCodeBlocks = 0): void => {
      const outsideSpans = out.replace(/(?<!\\)`[^`\n]*`/g, '');
      for (let i = 0; i < outsideSpans.length; i += 1) {
        const c = outsideSpans[i];
        if ((c === '[' || c === '<') && !escaped(outsideSpans, i)) assert.fail(`unescaped ${c} in ${out}`);
      }
      assertNoInjectedMarkup(out, allowedCodeBlocks);
    };

    const cases: Record<string, string> = {
      nestedBracketLink: '[a [b] c](http:/\\/evil.com)',
      escapedBracketLink: '[a\\]b](http:/\\/evil.com)',
      escBracketJs: '[a\\]b](javascript:alert(1))',
      doubleNestedParens: '[x](javascript:a((1)))',
      backtickLinkJs: '[x](javascript:a`) more`',
      angleDest: '[x](<http:/\\/evil.com>)',
      imgNested: '![a [b]](http:/\\/evil.com/i.png)',
      refMultiline: '[r]:\n  http:/\\/evil.com\n\nsee [r] now',
      refInQuote: '> [r]: http:/\\/evil.com\n\nsee [r] now',
      fenceInList: '- item\n  ```js\n  evil()\n  ```',
      fenceInQuote: '> ```js\n> evil()\n> ```',
      tildeInList: '- item\n  ~~~\n  evil()\n  ~~~',
      fenceViaHtml: '<b>~~~</b>\nevil()\n<b>~~~</b>',
      fenceViaHtmlBacktick: '<i></i>```js\nevil()\n<i></i>```',
      fencePlain: '```js\nevil()\n```\n\n~~~\nevil2\n~~~',
      indentedCode: 'para\n\n    evil()',
      tabCode: 'para\n\n\tevil()',
      deepList: 'para\n\n          - evil()',
      listFence4: '1.  item\n\n    ```js\n    evil()\n\n    more\n    ```',
      htmlLtInAttr: '<img alt="<" src=x onerror=alert(1)>',
      htmlBacktickTrick: '<img src=x onerror=alert(1) alt="`">hi` tail',
      htmlAnchorTrick: '<a href="javascript:alert(1)" title="`">click` tail',
      cdata: '<![CDATA[x]]> <?php echo 1 ?>',
      unclosedComment: '<!-- hide\nrest',
      htmlBlock: '<div\nonclick="x">hi</div>',
      fakeBlank: ':::blank {kind="lesson" hint="fake"}\n:::',
      fakeDirective: ':::callout\nx\n:::',
      fakeDirectiveInList: '- :::callout\n  x',
      autolinkMailto: '<mailto:a@b.c> and www.evil.com',
      entityUrl: '[a\\]b](https&#58;//evil.com)',
      setext: 'Second\n======\n\ntext',
      escapedBacktickHtml: 'x \\`<b>x</b>` y',
      nestedBracketLink2: '[a [b] c](javascript:alert(1))',
      img: '![a](https://evil.com/i.png)',
      refCollapsed: '[r]: /x\n\n[r][] and [r]',
      bareWww: 'go www.evil.com now',
      wwwAfterWord: 'xwww.evil.com and a.www.evil.com and _www.evil.com_',
      wwwUpper: 'WWW.evil.com HTTPS://evil.com',
      wwwJoin: 'wwwwww.evil.com ww https://x w.evil.com',
      ftp: 'ftp://evil.com/x',
      email: 'mail evil@phish.com now',
      mailtoAuto: '<mailto:a@b.c>',
      ungroundedEmailSpan: 'x `evil@phish.com` y',
      escapedMailto: '\\<mailto:a@b.c\\>',
      urlTrailing: 'https://evil.com\\x and www.evil.com`x',
      urlJoin: 'wwwhttps://a(.evil.com',
      entityLink: '&#91;x&#93;(https://evil.com)',
      groundedHtmlSpan: 'see `<img src=x onerror=alert(1)>` ok',
      groundedHtmlGt: 'see `">hi` ok <img src=x alt="`">hi` tail',
      escBacktickGrounded: '\\``<img src=x onerror=alert(1)>` x',
      deepListInList: '- a\n\n          - evil()',
      deepListInList2: '- a\n          - evil()',
      listQuoteDeep: '- a\n\n        > evil()',
      quoteIndented: 'para\n\n      > evil()',
      quoteTab: 'para\n\n\t> evil()',
      quoteInner5: '>     evil()',
      listMarker5: '1.     evil()',
      quoteParaDeep: '> para\n>\n>       - evil()',
      quoteListDeep: '> - a\n>           - evil()',
      markerSpacesList: '-     - evil()',
      markerSpacesList2: '1.      - evil()',
      tabInList: '- a\n\t\t- evil()',
      groundedFenceSpan: '```js``` and\n```js',
      fakeDirectiveList: '- :::blank {kind="lesson"}\n  :::',
      fakeDirectiveQuote: '> :::blank {kind="lesson"}\n> :::',
      fakeDirectiveIndent: '   :::blank {kind="lesson"}\n   :::',
      wwwParen: '(www.evil.com) *www.evil.com* ~www.evil.com~',
    };
    for (const [name, value] of Object.entries(cases)) {
      it(`${name} 은 링크·HTML·코드·지시문이 되지 않는다`, () => {
        assertInert(probe(value));
      });
    }

    it('bare URL 과 www 는 지운다', () => {
      const out = probe('see https://bare.com/p and www.evil.com/x end');
      assert.equal(out, 'see   and   end');
    });

    it('모델이 쓴 링크는 글자가 그대로 보이게 이스케이프된다', () => {
      assert.equal(probe('[글자](http:/\\/x.com) ![그림](a)'), '\\[글자\\](http:/\\\\/x.com) !\\[그림\\](a)');
    });

    it('가짜 빈칸·지시문은 글자로만 남는다', () => {
      assert.equal(
        probe(':::blank {kind="lesson" hint="fake"}\n:::'),
        '\\:::blank {kind="lesson" hint="fake"}\n\\:::',
      );
      assert.equal(probe(':::callout\nx\n:::'), '\\:::callout\nx\n\\:::');
    });

    it('Promise<void> 와 foo() 는 보이게 남고 근거 있는 코드 조각은 유지한다', () => {
      assert.equal(probe('call foo() and `bar()` then Promise<void>'), 'call foo() and bar() then Promise\\<void\\>');
      assert.equal(probe('call `<b>x</b>` ok'), 'call `<b>x</b>` ok');
    });

    it('울타리 모양은 이스케이프되어 코드 블록이 되지 않는다', () => {
      assert.equal(probe('```js\nevil()\n```'), '\\`\\`\\`js\nevil()\n\\`\\`\\`');
      assert.equal(probe('~~~\nx\n~~~'), '\\~~~\nx\n\\~~~');
    });

    it('링크 제목의 HTML·강조 문자를 이스케이프한다', () => {
      const out = probe('{{link:L1}}');
      assert.ok(out.startsWith('[\\<img src=x onerror=alert(1)\\> \\*t\\* www.t.com](https://ex.com/a)'), out);
      assert.ok(out.includes('- [\\<img src=x onerror=alert(1)\\> \\*t\\* www.t.com](https://ex.com/a)'), out);
    });

    it('인용 블록은 유지하고 안의 내용은 무력화한다', () => {
      assert.equal(probe('> 핵심 사실 문장'), '> 핵심 사실 문장');
      assert.equal(probe('> > 중첩\n- > 목록 안'), '> > 중첩\n- > 목록 안');
      assert.equal(probe('> [x](http:/\\/evil.com)'), '> \\[x\\](http:/\\\\/evil.com)');
      assert.equal(probe('> :::blank {kind="lesson"}'), '> \\:::blank {kind="lesson"}');
      assert.equal(probe('> ~~~\n> x'), '> \\~~~\n> x');
      assert.equal(probe('> ```js\n> x'), '> \\`\\`\\`js\n> x');
      assert.equal(probe('> <b>x</b>'), '> \\<b\\>x\\</b\\>');
      assertInert(probe('> [x](http:/\\/evil.com)\n> > <i>'));
    });

    it('줄 중간의 > 는 이스케이프한다', () => {
      assert.equal(probe('a > b'), 'a \\> b');
    });

    it('검사 도구가 나쁜 Markdown 에서는 실제로 실패한다', () => {
      for (const bad of [
        '# T\n\n```js\nx\n```',
        '# T\n\n    indented',
        '# T\n\n- a\n\n      deep',
        '# T\n\n<b>x</b>',
        '# T\n\n[a](http://evil.com)',
        '# T\n\n![a](http://x.com/i.png)',
        '# T\n\nwww.evil.com',
        '# T\n\n:::callout\nx\n:::',
        '# T\n\n> ~~~\n> x',
        '# T\n\n[r]: /x\n\n[r]',
      ]) {
        assert.throws(() => assertNoInjectedMarkup(bad), bad);
      }
      assert.throws(() => assertNoInjectedMarkup('# T\n\n:::blank {kind="lesson" hint="x"}\n:::'));
      assert.doesNotThrow(() => assertNoInjectedMarkup('# T\n\n:::blank {kind="lesson" hint="x"}\n:::', 0, 1));
    });

    // 검토에서 나온 우회 사례: [본문, 넣은 코드 블록 수, 넣은 빈칸 수]
    const reviewed: Record<string, [string, number, number]> = {
      f1_xwww: ['xwww.evil.com and a.www.evil.com and _www.evil.com_', 0, 0],
      f2_email: ['mail evil@phish.com now', 0, 0],
      f2_mailto: ['\\<mailto:a@b.c\\>', 0, 0],
      f2_span: ['x `evil@phish.com` y', 0, 0],
      f3_a: ['- a\n\n          - evil()', 0, 0],
      f3_b: ['- a\n\n        > evil()', 0, 0],
      f3_c: ['para\n\n      > evil()', 0, 0],
      f3_d: ['para\n\n\t> evil()', 0, 0],
      f3_e: ['> para\n>\n>       - evil()', 0, 0],
      f3_f: ['-     - evil()', 0, 0],
      f4_bang: ['!{{link:L1}} and !{{commit:C1}} and !!{{link:L1}}', 0, 0],
      legit_lists: ['- a\n- b\n  - b1\n    - b2\n- c\n\n1. one\n2. two\n   1. two-a\n3. three', 0, 0],
      legit_quoteInList: ['- a\n  > q', 0, 0],
      legit_listInQuote: ['> - a\n>   - b', 0, 0],
      emptyItem: ['-\n\n      evil()', 0, 0],
      emptyOrdered: ['1.\n\n       evil()', 0, 0],
      orderedNoInterrupt: ['para\n2. x\n\n      evil()', 0, 0],
      hrStars: ['* * *\n\n      evil()', 0, 0],
      hrDashes: ['- - -\n\n      evil()', 0, 0],
      setextDash: ['para\n-\n\n      evil()', 0, 0],
      lazyList: ['- a\nlazy\n\n      evil()', 0, 0],
      deepNest: ['- a\n  - b\n    - c\n      - d\n        - e\n\n            evil()', 0, 0],
      mixedTabs: ['- a\n\n \t\tevil()', 0, 0],
      quoteTabs: ['>\t\tevil()', 0, 0],
      listTabMarker: ['-\tx\n\n\t\tevil()', 0, 0],
      unkJoinWww: ['ww{{link:L9}}w.evil.com', 0, 0],
      unkJoinHttps: ['htt{{commit:C9}}ps://evil.com', 0, 0],
      unkJoinCodeFail: ['ww{{code:S9}}w.evil.com', 0, 0],
      unkJoinDirective: [':{{link:L9}}::blank {kind="lesson"}\n:{{link:L9}}::', 0, 0],
      unkJoinFence: ['~{{link:L9}}~~\nevil()\n~{{link:L9}}~~', 0, 0],
      unkJoinIndent: ['para\n\n   {{link:L9}} evil()', 0, 0],
      afterBlockFence: ['para {{code:S1}}~~~\nevil()\n~~~', 1, 0],
      afterBlockDirective: ['x {{ask:U1}}:::blank {kind="lesson"}\n:::', 0, 1],
      blockInList: ['- {{code:S1}}\n\n      evil()', 1, 0],
      blockMidList: ['- a {{code:S1}} b\n\n      evil()', 1, 0],
      blockMidOrdered: ['1. a {{ask:U1}} b\n\n       evil()', 0, 1],
      urlLeadFence: ['https://x ~~~\nevil()\nhttps://x ~~~', 0, 0],
      urlLeadDirective: ['www.x :::blank {kind="lesson"}\nwww.x :::', 0, 0],
      urlLeadTab: ['para\n\nwww.x\tevil()', 0, 0],
      urlLeadSpaces: ['para\n\nwww.x    evil()', 0, 0],
      spanFence: ['`~~~`\nevil()\n`~~~`', 0, 0],
      spanDirective: ['`:::blank {kind="lesson"}`\n`:::`', 0, 0],
      spanIndent: ['para\n\n`    evil()`', 0, 0],
      spanSetext: ['para\n`===`', 0, 0],
      thematicStars: ['* * *', 0, 0],
      thematicDashes: ['- - -', 0, 0],
      setextDashOnly: ['para\n-', 0, 0],
      dashOnly: ['-', 0, 0],
      orderedOnly: ['1.', 0, 0],
      emptyItemBetween: ['- a\n-\n- b', 0, 0],
    };
    for (const [name, [value, code, blank]] of Object.entries(reviewed)) {
      it(`검토 사례 ${name}`, () => {
        const out = run(`# T\n\nbody\n\n${value}`, {
          hunks: new Map([[probeHunk.id, probeHunk]]),
          links: probeLinks,
        });
        assertNoInjectedMarkup(out, code, blank);
      });
    }

    it('어떤 입력에서도 invalid_result 외의 오류는 나오지 않는다', () => {
      for (const value of ['* * *', '- - -', 'para\n-', '-', '1.', '- a\n-\n- b', ' ', '`']) {
        try {
          run(`# T\n\nbody\n\n${value}`);
        } catch (e) {
          assert.ok(e instanceof GenerationFailure && e.code === 'invalid_result');
        }
      }
    });

    it('합법적인 중첩 목록과 목록 안 인용은 그대로 목록·인용으로 읽힌다', () => {
      for (const value of [
        '- a\n- b\n  - b1\n    - b2\n- c\n\n1. one\n2. two\n   1. two-a\n3. three',
        '10. ten\n    - sub\n11. eleven',
        '> - a\n>   - b',
        '- a\n  > q',
        '- a\n  - b\n\n    para under b\n- c',
        '> quote line\n> second\n>\n> > nested',
      ]) {
        const out = probe(value);
        assert.equal(out, value);
        const types = assertNoInjectedMarkup(out).map((t) => t.type);
        assert.ok(types.includes('list') || types.includes('blockquote'));
      }
      const nested = assertNoInjectedMarkup(probe('- a\n  > q'));
      assert.ok(nested.some((t) => t.type === 'blockquote'));
    });

    it('링크 앞 느낌표는 이미지가 되지 않는다', () => {
      assertNoInjectedMarkup(probe('!{{link:L1}} and !{{commit:C1}} 와 !!{{link:L1}}'));
    });

    it('www·이메일·느낌표 링크를 막는다', () => {
      assert.equal(probe('xwww.evil.com and _www.evil.com_'), 'x  and _');
      assert.equal(probe('mail evil@phish.com'), 'mail evil\\@phish.com');
      assert.equal(probe('x `evil@phish.com` y'), 'x evil\\@phish.com y');
      // 커밋 자리표시자는 공백으로 지워지므로 느낌표는 글자로만 남는다
      assert.equal(probe('!{{commit:C1}} x'), '!  x');
    });

    it('들여쓰기 코드가 되는 깊은 들여쓰기는 3칸까지만 남는다', () => {
      assert.equal(probe('para\n\n      > evil()'), 'para\n\n   > evil()');
      assert.equal(probe('-     - evil()'), '- ' + '   - evil()');
    });

    it('목록 들여쓰기와 중첩 목록은 유지한다', () => {
      assert.equal(probe('- a\n  - b\n    - c'), '- a\n  - b\n    - c');
    });
  });
});

describe('assemble 표·URL 괄호', () => {
  // comdraft 편집기에는 표 확장이 없어 표가 통째로 사라지므로 표가 생기지 않게 한다
  const lexTypes = (markdown: string): string[] => {
    const found: Token[] = [];
    collectTokens(new Lexer({ gfm: true }).lex(markdown), found);
    return found.map((token) => token.type);
  };

  it('모델이 쓴 표는 표가 되지 않고 글자로 남는다', () => {
    const out = run('# T\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    assert.equal(lexTypes(out).includes('table'), false, out);
    assert.equal(out, '# T\n\n\\| a \\| b \\|\n\\|---\\|---\\|\n\\| 1 \\| 2 \\|');
  });

  it('세로선 없는 정렬 줄(:---)로도 한 칸짜리 표가 생기지 않는다', () => {
    for (const row of [':---', '---:', ':-:', '  :--']) {
      const out = run(`# T\n\na\n${row}`);
      assert.equal(lexTypes(out).includes('table'), false, out);
      assert.ok(out.includes('a\n'), out);
    }
  });

  it('세로선은 그대로 두고 --- 구분선과 제목 밑줄은 건드리지 않는다', () => {
    assert.equal(run('# T\n\nx\n\n---\n\ny'), '# T\n\nx\n\n---\n\ny');
  });

  it('세로선이 든 근거 있는 인라인 코드가 줄에 있어도 표가 생기지 않는다', () => {
    const pipeHunk = hunk('C1.F1.H1', ['+a|b', '+x|---|y', '+|---|']);
    for (const markdown of [
      'h | `a|b` | h\n|---|---|---|\n1 | 2 | 3',
      'h | `a|b` | h\n|---|---|---|---|\n1 | 2 | 3 | 4',
      'h | h | h\n`x|---|y`\n1 | 2 | 3',
      'h\n`|---|`',
    ]) {
      const out = run(`# T\n\n${markdown}`, { hunks: new Map([[pipeHunk.id, pipeHunk]]) });
      assert.equal(lexTypes(out).includes('table'), false, out);
      assert.ok(out.includes('`'), out);
    }
  });

  it('링크 제목의 세로선을 이스케이프한다', () => {
    const out = run('# T\n\n{{link:L1}}', {
      links: [{ id: 'L1', url: 'https://example.com/post', title: 'a | b', text: '' }],
    });
    assert.ok(out.includes('[a \\| b](https://example.com/post)'), out);
  });

  it('URL 의 괄호는 인코딩해 짝이 맞지 않는 ) 가 링크를 끊지 못한다', () => {
    const url = 'https://ex.com/a)b(c';
    const out = run('# T\n\n{{link:L1}}', {
      links: [{ id: 'L1', url, title: 't', text: '' }],
    });
    const found: Token[] = [];
    collectTokens(new Lexer({ gfm: true }).lex(out), found);
    const link = found.find((token) => token.type === 'link') as unknown as { href: string; text: string };
    assert.equal(link.href, 'https://ex.com/a%29b%28c');
    assert.equal(link.text, 't');
  });
});
