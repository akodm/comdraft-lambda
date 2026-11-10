import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CommitDetail } from '../github.ts';
import {
  HUNK_TOKEN_BUDGET,
  MAX_HUNK_LINE_CHARS,
  MAX_HUNK_LINES,
  MAX_SELECTED_HUNKS,
} from './limits.ts';
import {
  indexHunks,
  languageForFile,
  prepareCommits,
  selectHunks,
  type PreparedHunk,
} from './prepare.ts';

const commit = (sha: string, files: CommitDetail['files'], message = 'msg'): CommitDetail => ({
  sha,
  message,
  htmlUrl: `https://github.com/o/r/commit/${sha}`,
  files,
});
const file = (filename: string, patch?: string) => ({
  filename,
  status: 'modified',
  additions: 1,
  deletions: 0,
  patch,
});
const PATCH = '@@ -1,2 +1,3 @@ fn a\n x\n+y\n z\n@@ -10,1 +11,2 @@ fn b\n a\n+b';

describe('prepareCommits', () => {
  it('오래된 커밋이 C1, 파일과 hunk 에 번호를 붙인다', () => {
    const prepared = prepareCommits([
      commit('b', [file('x.ts', PATCH)]),
      commit('a', [file('p.ts', PATCH), file('q.ts', PATCH)]),
    ]);
    assert.equal(prepared[0].id, 'C1');
    assert.equal(prepared[0].sha, 'a');
    assert.equal(prepared[1].sha, 'b');
    const index = indexHunks(prepared);
    assert.ok(index.has('C1.F2.H2'));
    assert.equal(index.get('C1.F2.H2')?.header, '@@ -10,1 +11,2 @@ fn b');
    assert.deepEqual(index.get('C1.F2.H2')?.lines, [' a', '+b']);
    assert.equal(index.get('C1.F1.H1')?.language, 'ts');
  });

  it('lock·빌드 결과물은 본문을 뺀다', () => {
    const [c] = prepareCommits([
      commit('a', [file('pnpm-lock.yaml', PATCH), file('dist/x.js', PATCH), file('a.min.js', PATCH)]),
    ]);
    for (const f of c.files) {
      assert.equal(f.body, 'excluded', f.filename);
      assert.deepEqual(f.hunks, []);
    }
  });

  it('patch 없는 파일은 missing, 비밀 파일은 secret', () => {
    const [c] = prepareCommits([commit('a', [file('big.ts'), file('.env.local', PATCH)])]);
    assert.equal(c.files[0].body, 'missing');
    assert.equal(c.files[1].body, 'secret');
    assert.deepEqual(c.files[1].hunks, []);
  });

  it('비밀값이 든 hunk 는 가린다', () => {
    const [c] = prepareCommits([
      commit('a', [file('x.ts', '@@ -1 +1 @@\n+const k = "ghp_' + 'a'.repeat(36) + '";')]),
    ]);
    assert.deepEqual(c.files[0].hunks[0].lines, ['[가림]']);
    assert.equal(c.files[0].hunks[0].redacted, true);
    assert.equal(c.files[0].hunks[0].id, 'C1.F1.H1');
  });

  it('"\\ No newline" 줄은 번호에서 뺀다', () => {
    const [c] = prepareCommits([
      commit('a', [file('x.ts', '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b')]),
    ]);
    assert.deepEqual(c.files[0].hunks[0].lines, ['-a', '+b']);
  });

  it('hunk 는 150줄까지만', () => {
    const body = Array.from({ length: 200 }, (_, i) => `+l${i}`).join('\n');
    const [c] = prepareCommits([commit('a', [file('x.ts', `@@ -0,0 +1,200 @@\n${body}`)])]);
    assert.equal(c.files[0].hunks[0].lines.length, MAX_HUNK_LINES);
    assert.equal(c.files[0].hunks[0].lines[0], '+l0');
  });

  it('커밋 메시지의 비밀값은 가린다', () => {
    const [c] = prepareCommits([commit('a', [], 'fix: ghp_' + 'a'.repeat(36) + ' 제거')]);
    assert.equal(c.message, 'fix: [가림] 제거');
  });

  it('1000자 경계에 걸친 비밀값도 자르기 전에 가린다', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const message = 'm'.repeat(990) + token + ' 끝';
    const [c] = prepareCommits([commit('a', [], message)]);
    assert.equal(c.message.includes('ghp_'), false);
    assert.equal(c.message.includes('aaaaaa'), false);
    assert.ok(c.message.startsWith('m'.repeat(990) + '[가림]'));
    assert.ok(c.message.length <= 1000);
  });

  it('아주 긴 커밋 메시지도 앞부분만 검사해 빨리 끝난다', () => {
    const started = performance.now();
    const [c] = prepareCommits([commit('a', [], 'x'.repeat(1_000_000))]);
    assert.ok(performance.now() - started < 500);
    assert.equal(c.message.length, 1000);
  });

  it('너무 긴 줄이 있는 hunk(minified 등)는 본문 대신 생략 표시로 둔다', () => {
    const [c] = prepareCommits([
      commit('a', [file('x.js', `@@ -1 +1 @@\n-a\n+${'b'.repeat(MAX_HUNK_LINE_CHARS + 1)}`)]),
    ]);
    assert.deepEqual(c.files[0].hunks[0].lines, ['[긴 줄 생략]']);
    assert.equal(c.files[0].hunks[0].redacted, true);
  });

  it('메시지는 1000자, 파일은 50개까지', () => {
    const files = Array.from({ length: 60 }, (_, i) => file(`f${i}.ts`, PATCH));
    const [c] = prepareCommits([commit('a', files, 'm'.repeat(1500))]);
    assert.equal(c.message.length, 1000);
    assert.equal(c.files.length, 50);
  });
});

const hunk = (id: string, lines: string[], redacted = false): PreparedHunk => ({
  id,
  header: '@@',
  lines,
  redacted,
  language: 'ts',
});

describe('selectHunks', () => {
  it('가림·중복·없는 id 를 빼고 순서를 지킨다', () => {
    const index = new Map([
      ['A', hunk('A', ['a'])],
      ['B', hunk('B', ['[가림]'], true)],
      ['C', hunk('C', ['c'])],
    ]);
    assert.deepEqual(
      selectHunks(index, ['C', 'X', 'B', 'A', 'C']).map((h) => h.id),
      ['C', 'A'],
    );
  });

  it('30개에서 멈춘다', () => {
    const index = new Map(Array.from({ length: 40 }, (_, i) => [`H${i}`, hunk(`H${i}`, ['a'])]));
    assert.equal(selectHunks(index, [...index.keys()]).length, MAX_SELECTED_HUNKS);
  });

  it('토큰 상한에서 멈춘다', () => {
    const big = 'a'.repeat(HUNK_TOKEN_BUDGET * 3 - 10);
    const index = new Map([
      ['A', hunk('A', [big])],
      ['B', hunk('B', ['b'.repeat(30)])],
      ['C', hunk('C', ['c'])],
    ]);
    assert.deepEqual(
      selectHunks(index, ['A', 'B', 'C']).map((h) => h.id),
      ['A'],
    );
  });
});

describe('languageForFile', () => {
  it('확장자로 언어를 정한다', () => {
    assert.equal(languageForFile('a/b.tsx'), 'tsx');
    assert.equal(languageForFile('a/b.mjs'), 'js');
    assert.equal(languageForFile('a/b.yml'), 'yaml');
    assert.equal(languageForFile('Makefile'), 'plaintext');
  });
});
