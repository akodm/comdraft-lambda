import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PreparedHunk } from './prepare.ts';
import type { Analysis, BlankKind, Plan } from './schemas.ts';
import { sanitizeHint, validateAnalysis, validatePlan } from './validate.ts';

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
});

const empty: Analysis = { facts: [], code: [], unknowns: [] };

describe('validatePlan', () => {
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

  it('사실도 unknown 도 없는 절에 detail unknown 을 만든다', () => {
    const input: Analysis = {
      ...empty,
      facts: [{ id: 'K1', section: 0, text: 'a', evidence: ['C9'] }],
      unknowns: [{ id: 'U3', section: 9, kind: 'detail', ask: 'x' }],
    };
    const out = validateAnalysis(input, ctxFor(p));
    assert.deepEqual(
      out.unknowns.map((u) => [u.id, u.section, u.kind, u.ask]),
      [
        ['U4', 0, 'detail', '자세한 내용'],
        ['U5', 1, 'detail', '자세한 내용'],
      ],
    );
    assert.equal(input.unknowns.length, 1);
  });
});
