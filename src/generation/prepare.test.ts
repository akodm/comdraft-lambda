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
  prepareSnippets,
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

  it('다른 언어의 lock·빌드 결과물·생성 코드도 본문을 뺀다', () => {
    const names = [
      'target/release/app.d',
      'core/target/classes/A.class.txt',
      'Api/obj/project.assets.json',
      '.gradle/8.5/checksums.txt',
      'pkg/__pycache__/a.cpython-312.pyc',
      'packages.lock.json',
      'gradle.lockfile',
      'Pipfile.lock',
      'uv.lock',
      'Podfile.lock',
      'Package.resolved',
      'mix.lock',
      'pubspec.lock',
      'api/user.pb.go',
      'proto/user_pb2.py',
      'Forms/Main.Designer.cs',
    ];
    const [c] = prepareCommits([commit('a', names.map((name) => file(name, PATCH)))]);
    for (const f of c.files) assert.equal(f.body, 'excluded', f.filename);
  });

  it('Rails 의 bin 스크립트와 스키마, Go 의 cmd 는 본문을 남긴다', () => {
    const [c] = prepareCommits([
      commit('a', [file('bin/setup', PATCH), file('db/schema.rb', PATCH), file('cmd/server/main.go', PATCH)]),
    ]);
    for (const f of c.files) assert.equal(f.body, 'included', f.filename);
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
    assert.equal(languageForFile('a/b.unknown'), 'plaintext');
  });

  it('JS 밖의 언어와 확장자 없는 빌드 파일도 언어를 붙인다', () => {
    assert.equal(languageForFile('src/main.cpp'), 'cpp');
    assert.equal(languageForFile('include/a.hpp'), 'cpp');
    assert.equal(languageForFile('lib/a.c'), 'c');
    assert.equal(languageForFile('Api/UserService.cs'), 'csharp');
    assert.equal(languageForFile('app/views/users/index.html.erb'), 'erb');
    assert.equal(languageForFile('lib/tasks/seed.rake'), 'rb');
    assert.equal(languageForFile('Cargo.toml'), 'toml');
    assert.equal(languageForFile('pom.xml'), 'xml');
    assert.equal(languageForFile('build.gradle'), 'groovy');
    assert.equal(languageForFile('build.gradle.kts'), 'kt');
    assert.equal(languageForFile('Gemfile'), 'rb');
    assert.equal(languageForFile('docker/Dockerfile'), 'dockerfile');
    assert.equal(languageForFile('Makefile'), 'makefile');
  });
});

describe('prepareSnippets', () => {
  const code = (count: number) => Array.from({ length: count }, (_, i) => `const v${i} = ${i};`).join('\n');

  it('직접 입력 코드 하나를 소스 P 번호와 파일 하나로 만들고 150줄 단위로 조각을 나눈다', () => {
    const [source] = prepareSnippets([{ name: 'src/useAuth.ts', code: code(320) }]);
    assert.equal(source.id, 'P1');
    assert.equal(source.kind, 'snippet');
    assert.equal(source.sha, '');
    assert.equal(source.message, '');
    assert.equal(source.files.length, 1);
    const [only] = source.files;
    assert.equal(only.id, 'P1.F1');
    assert.equal(only.filename, 'src/useAuth.ts');
    assert.equal(only.status, 'provided');
    assert.equal(only.additions, 320);
    assert.equal(only.body, 'included');
    assert.deepEqual(
      only.hunks.map((hunk) => [hunk.id, hunk.lines.length, hunk.header]),
      [
        ['P1.F1.H1', MAX_HUNK_LINES, '@@ 1-150 @@'],
        ['P1.F1.H2', MAX_HUNK_LINES, '@@ 151-300 @@'],
        ['P1.F1.H3', 20, '@@ 301-320 @@'],
      ],
    );
    // 변경 내역이 아니라 보여 준 코드라 줄 앞 기호는 모두 공백
    assert.ok(only.hunks.every((hunk) => hunk.lines.every((line) => line.startsWith(' '))));
    assert.equal(only.hunks[0].lines[0], ' const v0 = 0;');
    assert.equal(only.hunks[0].language, 'ts');
  });

  it('여러 코드는 입력 순서대로 P1, P2', () => {
    const sources = prepareSnippets([
      { name: 'a.py', code: 'x = 1' },
      { name: '코드 2', code: 'y' },
    ]);
    assert.deepEqual(sources.map((source) => source.id), ['P1', 'P2']);
    assert.equal(sources[1].files[0].hunks[0].language, 'plaintext');
  });

  it('비밀값 파일 이름이면 본문을 넘기지 않고, 비밀값이 든 조각은 가린다', () => {
    const [secretFile] = prepareSnippets([{ name: '.env', code: 'A=1' }]);
    assert.equal(secretFile.files[0].body, 'secret');
    assert.equal(secretFile.files[0].hunks.length, 0);

    const [withSecret] = prepareSnippets([
      { name: 'a.ts', code: `const key = 'AKIAIOSFODNN7EXAMPLE';\nconst ok = 1;` },
    ]);
    assert.equal(withSecret.files[0].hunks[0].redacted, true);
    assert.ok(!withSecret.files[0].hunks[0].lines.join('\n').includes('AKIA'));
  });

  it('아주 긴 줄이 있는 조각은 본문을 넘기지 않는다', () => {
    const [source] = prepareSnippets([{ name: 'a.js', code: 'x'.repeat(MAX_HUNK_LINE_CHARS + 1) }]);
    assert.equal(source.files[0].hunks[0].redacted, true);
  });

  it('커밋은 kind 가 commit 이고, 조각 색인에 소스 조각도 들어간다', () => {
    const commits = prepareCommits([commit('a', [file('x.ts', PATCH)])]);
    assert.equal(commits[0].kind, 'commit');
    const index = indexHunks([...commits, ...prepareSnippets([{ name: 'a.ts', code: 'x' }])]);
    assert.ok(index.has('C1.F1.H1'));
    assert.ok(index.has('P1.F1.H1'));
  });
});

describe('languageForFile 의 이름 조회', () => {
  it('객체 기본 속성 이름(constructor, __proto__, toString)은 언어로 보지 않는다', () => {
    for (const name of ['constructor', 'a.constructor', '__proto__', 'a.__proto__', 'toString', 'a.hasOwnProperty']) {
      assert.equal(languageForFile(name), 'plaintext', name);
    }
    assert.equal(prepareSnippets([{ name: 'a.constructor', code: 'x' }])[0].files[0].hunks[0].language, 'plaintext');
  });
});
