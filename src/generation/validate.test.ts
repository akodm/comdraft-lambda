import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PreparedHunk } from './prepare.ts';
import { AnalysisSchema, BLANK_LIMIT, type Analysis, type BlankKind, type Plan } from './schemas.ts';
import { missingHeadingLevels, sanitizeHint, validateAnalysis, validatePlan } from './validate.ts';

const section = (level: number, extra: Partial<Plan['sections'][number]> = {}) => ({
  level,
  heading: 'h',
  purpose: 'p',
  hunks: [],
  links: [],
  ...extra,
});

const plan = (sections: Plan['sections']): Plan => ({
  title: 't',
  takeaway: 'k',
  sections,
  excludedCommits: [],
  linkRoles: [],
});

const hunk = (id: string, count: number, redacted = false): PreparedHunk => ({
  id,
  header: '@@',
  lines: Array.from({ length: count }, (_, i) => `line ${i + 1}`),
  redacted,
  language: 'ts',
});

const defaults: Record<BlankKind, string> = {
  motivation: '계기',
  result: '결과',
  lesson: '배운 점',
  detail: '자세한 내용',
};

const ctxFor = (p: Plan, hunks: PreparedHunk[] = []) => ({
  plan: p,
  hunks: new Map(hunks.map((h) => [h.id, h])),
  commitIds: new Set(['C1', 'C2']),
  linkIds: new Set(['L1']),
  blankDefaults: defaults,
  length: 'long',
});

const empty: Analysis = { facts: [], code: [], unknowns: [] };

describe('missingHeadingLevels', () => {
  const planWith = (levels: number[]): Plan => ({
    title: 't',
    takeaway: 't',
    sections: levels.map((level, i) => ({ level, heading: `h${i}`, purpose: 'p', hunks: [], links: [] })),
    excludedCommits: [],
    linkRoles: [],
  });

  it('필수 블록의 제목 수준(h2~h6) 중 기획에 없는 수준을 작은 것부터 돌려준다', () => {
    // 실제 비교 실행: h2·h3·list·code 를 골랐는데 기획이 모든 절을 h2 로 잡았다
    assert.deepEqual(missingHeadingLevels(planWith([2, 2, 2]), ['h2', 'h3', 'list', 'code']), [3]);
    assert.deepEqual(missingHeadingLevels(planWith([2, 3, 2]), ['h2', 'h3', 'list', 'code']), []);
    assert.deepEqual(missingHeadingLevels(planWith([2, 3]), ['h5', 'h3', 'h4']), [4, 5]);
    // 글 제목(h1)과 제목이 아닌 블록은 보지 않는다
    assert.deepEqual(missingHeadingLevels(planWith([2]), ['h1', 'list', 'blockquote']), []);
  });
});

describe('validatePlan', () => {
  const ctxLinks = (ids: string[]) => ({
    hunkIds: new Set<string>(),
    linkIds: new Set(ids),
    length: 'medium',
  });

  it('linkRoles 는 모르는·중복 번호를 버리고 빠진 링크를 other 로 채워 입력 링크 순서로 둔다', () => {
    const raw = {
      ...plan([]),
      linkRoles: [
        { id: 'L2', role: 'docs', relation: '설정 절차를 따른다' },
        { id: 'L9', role: 'docs', relation: '없는 링크' },
        { id: 'L2', role: 'article', relation: '중복' },
        { id: 'L1', role: 'weird', relation: `  ${'x'.repeat(200)}` },
      ],
    };
    const out = validatePlan(raw, ctxLinks(['L1', 'L2', 'L3']));
    assert.deepEqual(out.linkRoles, [
      { id: 'L1', role: 'other', relation: 'x'.repeat(120) },
      { id: 'L2', role: 'docs', relation: '설정 절차를 따른다' },
      { id: 'L3', role: 'other', relation: '' },
    ]);
  });

  it('링크가 없으면 linkRoles 는 빈 목록이다', () => {
    const raw = { ...plan([]), linkRoles: [{ id: 'L1', role: 'docs', relation: 'x' }] };
    assert.deepEqual(validatePlan(raw, ctxLinks([])).linkRoles, []);
  });

  it('없는 hunk·link 를 빼고 절 수를 길이 범위로 자르고 level 건너뜀을 고친다', () => {
    const input = plan([
      section(2, { hunks: ['C1.F1.H1', 'C9.F1.H1'], links: ['L1', 'L7'] }),
      section(4),
      section(3),
      section(2),
      section(2),
    ]);
    const out = validatePlan(input, {
      hunkIds: new Set(['C1.F1.H1']),
      linkIds: new Set(['L1']),
      length: 'short',
    });
    assert.equal(out.sections.length, 3);
    assert.deepEqual(out.sections.map((s) => s.level), [2, 3, 3]);
    assert.deepEqual(out.sections[0].hunks, ['C1.F1.H1']);
    assert.deepEqual(out.sections[0].links, ['L1']);
    assert.equal(input.sections.length, 5);
  });

  it('알 수 없는 length 는 medium 범위, 첫 절 level 은 2..6 으로 맞춘다', () => {
    const many = plan(Array.from({ length: 7 }, () => section(1)));
    const out = validatePlan(many, { hunkIds: new Set(), linkIds: new Set(), length: 'x' });
    assert.equal(out.sections.length, 5);
    assert.equal(out.sections[0].level, 2);
    const few = validatePlan(plan([section(9)]), {
      hunkIds: new Set(),
      linkIds: new Set(),
      length: 'long',
    });
    assert.equal(few.sections.length, 1);
    assert.equal(few.sections[0].level, 6);
  });
});

describe('validateAnalysis', () => {
  const p = plan([section(2), section(3)]);

  it('없는 근거를 지우고 근거가 비면 사실을 버린다', () => {
    const out = validateAnalysis(
      {
        ...empty,
        facts: [
          { id: 'K1', section: 0, text: 'a', evidence: ['C1', 'C9', 'bad', 'L1', 'L2', 'R'] },
          { id: 'K2', section: 0, text: 'b', evidence: ['C9', 'C1.F1.H1'] },
          { id: 'K3', section: 5, text: 'c', evidence: ['R'] },
        ],
        unknowns: [{ id: 'U1', section: 1, kind: 'result', ask: '?' }],
      },
      ctxFor(p, [hunk('C2.F1.H1', 3)]),
    );
    assert.deepEqual(out.facts.map((f) => [f.id, f.evidence]), [['K1', ['C1', 'L1', 'R']]]);
  });

  it('가림·범위 밖·40줄 초과 코드를 버린다', () => {
    const pick = (id: string, from: string, s: number, e: number) => ({
      id,
      section: 0,
      from,
      startLine: s,
      endLine: e,
      mode: 'after' as const,
      point: 'p',
    });
    const out = validateAnalysis(
      {
        ...empty,
        code: [
          pick('S1', 'C1.F1.H1', 1, 3),
          pick('S2', 'C1.F1.H2', 1, 2),
          pick('S3', 'C1.F1.H1', 2, 9),
          pick('S4', 'C1.F1.H1', 0, 2),
          pick('S5', 'C1.F1.H1', 3, 2),
          pick('S6', 'C1.F1.H3', 1, 41),
          pick('S7', 'C1.F1.H3', 1, 40),
          pick('S8', 'C9.F1.H1', 1, 1),
        ],
      },
      ctxFor(p, [hunk('C1.F1.H1', 5), hunk('C1.F1.H2', 5, true), hunk('C1.F1.H3', 60)]),
    );
    assert.deepEqual(out.code.map((c) => c.id), ['S1', 'S7']);
  });

  it('블록 중간에서 끝나는 코드 조각은 괄호가 닫힐 때까지 늘린다 (40줄과 hunk 끝을 넘지 않음)', () => {
    // 실제 비교 실행: 라우터 훅 코드가 `refresh: () => {` 에서 잘렸다
    const code: PreparedHunk = {
      id: 'C1.F1.H1',
      header: '@@',
      lines: [
        '+export default function useRouterWrap() {',
        "+  const label = '{ 문자열 속 괄호 }';",
        '+  return {',
        '+    push: () => {',
        '+      go();',
        '+    },',
        '+  };',
        '+}',
        '+// 다음 코드',
      ],
      redacted: false,
      language: 'ts',
    };
    const pick = (id: string, s: number, e: number) => ({
      id, section: 0, from: 'C1.F1.H1', startLine: s, endLine: e, mode: 'after' as const, point: 'p',
    });
    const long: PreparedHunk = { ...code, id: 'C1.F1.H2', lines: ['+function f() {', ...Array.from({ length: 50 }, () => '+  x();'), '+}'] };
    const out = validateAnalysis(
      {
        ...empty,
        code: [
          pick('S1', 1, 4),
          // 이미 닫힌 조각은 그대로
          pick('S2', 9, 9),
          // 40줄 안에서 닫을 수 없으면 그대로 둔다
          { ...pick('S3', 1, 10), from: 'C1.F1.H2' },
        ],
      },
      ctxFor(p, [code, long]),
    );
    assert.deepEqual(
      out.code.map((c) => [c.id, c.startLine, c.endLine]),
      [['S1', 1, 8], ['S2', 9, 9], ['S3', 1, 10]],
    );
  });

  it('같은 hunk 에서 앞 조각과 줄이 겹치는 조각은 버린다 (표시 방식이 달라도)', () => {
    const pick = (id: string, from: string, s: number, e: number, mode: 'after' | 'diff' = 'after') => ({
      id,
      section: 0,
      from,
      startLine: s,
      endLine: e,
      mode,
      point: 'p',
    });
    const out = validateAnalysis(
      {
        ...empty,
        code: [
          pick('S1', 'C1.F1.H1', 1, 10),
          // S1 안에 들어가는 부분 (실제 비교 실행에서 같은 useEffect 가 두 번 실림)
          pick('S2', 'C1.F1.H1', 4, 8),
          // 끝줄 하나만 겹쳐도 버린다
          pick('S3', 'C1.F1.H1', 10, 14, 'diff'),
          // 바로 다음 줄부터는 겹치지 않는다
          pick('S4', 'C1.F1.H1', 11, 14),
          // 다른 hunk 는 줄 번호가 같아도 겹치지 않는다
          pick('S5', 'C1.F1.H2', 1, 10),
        ],
      },
      ctxFor(p, [hunk('C1.F1.H1', 20), hunk('C1.F1.H2', 20)]),
    );
    assert.deepEqual(out.code.map((c) => c.id), ['S1', 'S4', 'S5']);
  });

  it('빈 ask 는 kind 기본 문구, hint 특수 문자를 정리한다', () => {
    assert.equal(sanitizeHint('왜 "이걸"\n{했나} ::: 요'), '왜 이걸 했나 요');
    assert.equal(sanitizeHint('가'.repeat(100)).length, 80);
    const out = validateAnalysis(
      {
        ...empty,
        unknowns: [
          { id: 'U1', section: 0, kind: 'lesson', ask: ' "" ' },
          { id: 'U2', section: 1, kind: 'result', ask: '수치\n는?' },
        ],
      },
      ctxFor(p),
    );
    assert.deepEqual(out.unknowns.map((u) => u.ask), ['배운 점', '수치 는?']);
  });

  it('재료가 없는 절에도 빈칸을 만들지 않는다 (작성 단계가 이웃 절과 합친다)', () => {
    const input: Analysis = {
      ...empty,
      facts: [
        { id: 'K1', section: 0, text: 'a', evidence: ['C9'] },
        { id: 'K2', section: 1, text: 'b', evidence: ['C1'] },
      ],
      unknowns: [{ id: 'U3', section: 9, kind: 'detail', ask: 'x' }],
    };
    const out = validateAnalysis(input, ctxFor(p));
    assert.deepEqual(out.unknowns, []);
    assert.deepEqual(out.facts.map((f) => f.id), ['K2']);
    assert.equal(input.unknowns.length, 1);
  });

  it('글 전체에 재료가 하나도 없으면 첫 절에 detail 빈칸 하나만 둔다', () => {
    const out = validateAnalysis(
      { ...empty, unknowns: [{ id: 'U3', section: 9, kind: 'detail', ask: 'x' }] },
      ctxFor(p),
    );
    assert.deepEqual(
      out.unknowns.map((u) => [u.id, u.section, u.kind, u.ask]),
      [['U4', 0, 'detail', '자세한 내용']],
    );
  });

  it('코드만 있는 글은 빈칸을 더하지 않는다', () => {
    const out = validateAnalysis(
      {
        ...empty,
        code: [{ id: 'S1', section: 1, from: 'C1.F1.H1', startLine: 1, endLine: 2, mode: 'after', point: 'p' }],
      },
      ctxFor(p, [hunk('C1.F1.H1', 3)]),
    );
    assert.deepEqual(out.unknowns, []);
  });

  it('sanitizeHint: 따옴표·중괄호를 지운 뒤 ::: 가 다시 생기지 않는다', () => {
    for (const input of ['"::{:"', '":\":"', ':::::', '::"":']) {
      assert.equal(sanitizeHint(input).includes(':::'), false, input);
    }
  });

  it('가린 hunk 만 근거인 사실은 버리고, 다른 재료가 있으면 빈칸을 더하지 않는다', () => {
    const out = validateAnalysis(
      {
        ...empty,
        facts: [{ id: 'K1', section: 0, text: 'a', evidence: ['C1.F1.H2'] }],
        unknowns: [{ id: 'U1', section: 1, kind: 'result', ask: '?' }],
      },
      ctxFor(p, [hunk('C1.F1.H2', 5, true)]),
    );
    assert.deepEqual(out.facts, []);
    assert.deepEqual(out.unknowns.map((u) => [u.id, u.section]), [['U1', 1]]);
  });
});

describe('validateAnalysis 빈칸 상한', () => {
  const p = plan([section(2), section(2), section(2)]);
  const unknowns = (count: number): Analysis['unknowns'] =>
    Array.from({ length: count }, (_, i) => ({
      id: `U${i + 1}`,
      section: i % 3,
      kind: 'detail' as const,
      ask: `질문 ${i + 1}`,
    }));
  const run = (length: string, count = 4) =>
    validateAnalysis({ ...empty, unknowns: unknowns(count) }, { ...ctxFor(p), length });

  it('BLANK_LIMIT 은 short 1, medium 2, long 3', () => {
    assert.deepEqual(BLANK_LIMIT, { short: 1, medium: 2, long: 3 });
  });

  it('상한을 넘으면 앞에서부터 상한까지만 남긴다 (4개 → medium 2개)', () => {
    assert.deepEqual(run('medium').unknowns.map((u) => u.id), ['U1', 'U2']);
    assert.deepEqual(run('short').unknowns.map((u) => u.id), ['U1']);
    assert.deepEqual(run('long').unknowns.map((u) => u.id), ['U1', 'U2', 'U3']);
  });

  it('알 수 없는 length 는 medium 상한, 상한 안이면 그대로 둔다', () => {
    assert.deepEqual(run('huge').unknowns.map((u) => u.id), ['U1', 'U2']);
    assert.deepEqual(run('long', 2).unknowns.map((u) => u.id), ['U1', 'U2']);
  });

  it('범위 밖 절의 빈칸은 상한을 세기 전에 버린다', () => {
    const out = validateAnalysis(
      {
        ...empty,
        unknowns: [
          { id: 'U1', section: 7, kind: 'detail', ask: 'a' },
          { id: 'U2', section: 0, kind: 'detail', ask: 'b' },
          { id: 'U3', section: 1, kind: 'detail', ask: 'c' },
        ],
      },
      { ...ctxFor(p), length: 'short' },
    );
    assert.deepEqual(out.unknowns.map((u) => u.id), ['U2']);
  });
});

describe('validateAnalysis 구조화 출력 값 보정', () => {
  // 구조화 출력은 enum 을 서버에서 강제하지 않으므로 목록 밖의 값이 올 수 있다
  it('목록에 없는 빈칸 종류는 detail, 목록에 있는 것은 그대로', () => {
    const p = plan([section(2), section(2)]);
    const out = validateAnalysis(
      {
        facts: [],
        code: [],
        unknowns: [
          { id: 'U1', section: 0, kind: 'surprise', ask: '' },
          { id: 'U2', section: 1, kind: 'lesson', ask: '무엇을 배웠나' },
        ],
      },
      ctxFor(p),
    );
    assert.deepEqual(
      out.unknowns.map((u) => [u.kind, u.ask]),
      [
        ['detail', '자세한 내용'],
        ['lesson', '무엇을 배웠나'],
      ],
    );
  });

  it('목록에 없는 코드 표시 방식은 after, diff 는 그대로', () => {
    const p = plan([section(2)]);
    const pick = { section: 0, from: 'C1.F1.H1', startLine: 1, endLine: 2, point: 'p' };
    const out = validateAnalysis(
      {
        facts: [],
        code: [
          { ...pick, id: 'K1', mode: 'before' },
          // 겹치는 조각은 버려지므로 다른 줄을 고른다
          { ...pick, id: 'K2', mode: 'diff', startLine: 3, endLine: 4 },
        ],
        unknowns: [{ id: 'U1', section: 0, kind: 'detail', ask: 'q' }],
      },
      ctxFor(p, [hunk('C1.F1.H1', 5)]),
    );
    assert.deepEqual(
      out.code.map((c) => c.mode),
      ['after', 'diff'],
    );
  });

  it('kind·mode 는 스키마에서 enum 으로 두지 않는다 (서버가 강제하지 않아 검증 코드에서 보정)', () => {
    const parsed = AnalysisSchema.safeParse({
      facts: [],
      code: [{ id: 'K1', section: 0, from: 'x', startLine: 1, endLine: 1, mode: 'before', point: '' }],
      unknowns: [{ id: 'U1', section: 0, kind: 'surprise', ask: '' }],
    });
    assert.equal(parsed.success, true);
  });
});
