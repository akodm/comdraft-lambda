import { MAX_CODE_LINES } from './limits.ts';
import type { PreparedHunk } from './prepare.ts';
import {
  EVIDENCE_PATTERN,
  SECTION_RANGE,
  type Analysis,
  type BlankKind,
  type Plan,
} from './schemas.ts';

const HINT_MAX = 80;
const MIN_LEVEL = 2;
const MAX_LEVEL = 6;

// 사용자에게 보여 줄 질문에서 템플릿·따옴표를 깨는 문자를 정리한다.
export const sanitizeHint = (text: string): string => {
  const cleaned = text
    .replace(/["{}]/g, '')
    // 따옴표 등을 먼저 지운 뒤 콜론 3개 이상 묶음을 통째로 지워 ::: 가 다시 생기지 않게 한다.
    .replace(/:{3,}/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, HINT_MAX).join('').trim();
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const sectionRange = (length: string): [number, number] =>
  Object.hasOwn(SECTION_RANGE, length)
    ? SECTION_RANGE[length as keyof typeof SECTION_RANGE]
    : SECTION_RANGE.medium;

// 없는 hunk·link 번호를 빼고, 절 수를 길이 범위로 자르고, level 건너뜀을 고친다.
export const validatePlan = (
  plan: Plan,
  ctx: { hunkIds: Set<string>; linkIds: Set<string>; length: string },
): Plan => {
  const [, max] = sectionRange(ctx.length);
  let previousLevel = 0;
  const sections = plan.sections.slice(0, max).map((section) => {
    const upper =
      previousLevel === 0 ? MAX_LEVEL : Math.min(MAX_LEVEL, previousLevel + 1);
    const level = clamp(section.level, MIN_LEVEL, upper);
    previousLevel = level;
    return {
      ...section,
      level,
      hunks: section.hunks.filter((id) => ctx.hunkIds.has(id)),
      links: section.links.filter((id) => ctx.linkIds.has(id)),
    };
  });
  return { ...plan, sections };
};

const isKnownEvidence = (
  id: string,
  commitIds: Set<string>,
  hunks: Map<string, PreparedHunk>,
  linkIds: Set<string>,
): boolean => {
  if (!EVIDENCE_PATTERN.test(id)) return false;
  if (id === 'R') return true;
  if (id.startsWith('L')) return linkIds.has(id);
  if (!id.includes('.')) return commitIds.has(id);
  // 가린 hunk 는 코드 선택과 같이 근거로도 쓰지 않는다.
  const hunk = hunks.get(id);
  return hunk !== undefined && !hunk.redacted;
};

const isValidCodePick = (
  pick: Analysis['code'][number],
  hunks: Map<string, PreparedHunk>,
): boolean => {
  const hunk = hunks.get(pick.from);
  if (!hunk || hunk.redacted) return false;
  if (pick.startLine < 1 || pick.startLine > pick.endLine) return false;
  if (pick.endLine > hunk.lines.length) return false;
  return pick.endLine - pick.startLine + 1 <= MAX_CODE_LINES;
};

const maxUnknownNumber = (unknowns: Analysis['unknowns']): number =>
  unknowns.reduce((max, u) => {
    const match = /^U(\d+)$/.exec(u.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

// 근거 없는 사실, 잘못된 코드 위치를 버리고 빈칸 문구를 정리한다.
// 사실도 unknown 도 없는 절에는 detail 빈칸을 만든다.
export const validateAnalysis = (
  analysis: Analysis,
  ctx: {
    plan: Plan;
    hunks: Map<string, PreparedHunk>;
    commitIds: Set<string>;
    linkIds: Set<string>;
    blankDefaults: Record<BlankKind, string>;
  },
): Analysis => {
  const sectionCount = ctx.plan.sections.length;
  const inRange = (section: number): boolean =>
    Number.isInteger(section) && section >= 0 && section < sectionCount;

  const facts = analysis.facts
    .filter((fact) => inRange(fact.section))
    .map((fact) => ({
      ...fact,
      evidence: fact.evidence.filter((id) =>
        isKnownEvidence(id, ctx.commitIds, ctx.hunks, ctx.linkIds),
      ),
    }))
    .filter((fact) => fact.evidence.length > 0);

  const code = analysis.code
    .filter((pick) => inRange(pick.section) && isValidCodePick(pick, ctx.hunks))
    .map((pick) => ({ ...pick }));

  const unknowns = analysis.unknowns
    .filter((unknown) => inRange(unknown.section))
    .map((unknown) => ({
      ...unknown,
      ask: sanitizeHint(unknown.ask) || ctx.blankDefaults[unknown.kind],
    }));

  let nextUnknown = maxUnknownNumber(analysis.unknowns) + 1;
  for (let section = 0; section < sectionCount; section += 1) {
    const covered =
      facts.some((f) => f.section === section) ||
      unknowns.some((u) => u.section === section);
    if (covered) continue;
    unknowns.push({
      id: `U${nextUnknown}`,
      section,
      kind: 'detail',
      ask: ctx.blankDefaults.detail,
    });
    nextUnknown += 1;
  }

  return { facts, code, unknowns };
};
