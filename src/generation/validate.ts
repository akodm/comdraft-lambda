import { MAX_CODE_LINES } from './limits.ts';
import type { PreparedHunk } from './prepare.ts';
import {
  BLANK_KINDS,
  BLANK_LIMIT,
  CODE_MODES,
  EVIDENCE_PATTERN,
  LINK_RELATION_MAX,
  LINK_ROLES,
  SECTION_RANGE,
  type Analysis,
  type BlankKind,
  type CodeMode,
  type LinkRole,
  type LinkRoleEntry,
  type Plan,
  type RawAnalysis,
  type RawPlan,
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

// 목록 밖의 값은 기본값으로 (comdraft normalizeBlankAttrs 와 같은 규칙)
const toBlankKind = (kind: string): BlankKind =>
  (BLANK_KINDS as readonly string[]).includes(kind) ? (kind as BlankKind) : 'detail';

const toCodeMode = (mode: string): CodeMode =>
  (CODE_MODES as readonly string[]).includes(mode) ? (mode as CodeMode) : 'after';

const toLinkRole = (role: string): LinkRole =>
  (LINK_ROLES as readonly string[]).includes(role) ? (role as LinkRole) : 'other';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const sectionRange = (length: string): [number, number] =>
  Object.hasOwn(SECTION_RANGE, length)
    ? SECTION_RANGE[length as keyof typeof SECTION_RANGE]
    : SECTION_RANGE.medium;

// 알 수 없는 length 는 절 수 범위와 같이 medium 상한을 쓴다
const blankLimit = (length: string): number =>
  Object.hasOwn(BLANK_LIMIT, length)
    ? BLANK_LIMIT[length as keyof typeof BLANK_LIMIT]
    : BLANK_LIMIT.medium;

// 입력 링크마다 역할 하나를 입력 순서대로 만든다. 모르는·중복 번호는 버리고,
// 빠진 링크는 other 와 빈 관계로 채우며, 관계는 앞뒤 공백을 뺀 뒤 상한까지만 남긴다.
const validateLinkRoles = (raw: RawPlan['linkRoles'], linkIds: Set<string>): LinkRoleEntry[] => {
  const byId = new Map<string, RawPlan['linkRoles'][number]>();
  for (const entry of raw) {
    if (linkIds.has(entry.id) && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...linkIds].map((id) => {
    const entry = byId.get(id);
    return {
      id,
      role: toLinkRole(entry?.role ?? ''),
      relation: Array.from((entry?.relation ?? '').trim()).slice(0, LINK_RELATION_MAX).join(''),
    };
  });
};

// 없는 hunk·link 번호를 빼고, 절 수를 길이 범위로 자르고, level 건너뜀을 고친다. 링크 역할도 보정한다.
export const validatePlan = (
  plan: RawPlan,
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
  return { ...plan, sections, linkRoles: validateLinkRoles(plan.linkRoles, ctx.linkIds) };
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
  pick: RawAnalysis['code'][number],
  hunks: Map<string, PreparedHunk>,
): boolean => {
  const hunk = hunks.get(pick.from);
  if (!hunk || hunk.redacted) return false;
  if (pick.startLine < 1 || pick.startLine > pick.endLine) return false;
  if (pick.endLine > hunk.lines.length) return false;
  return pick.endLine - pick.startLine + 1 <= MAX_CODE_LINES;
};

const maxUnknownNumber = (unknowns: RawAnalysis['unknowns']): number =>
  unknowns.reduce((max, u) => {
    const match = /^U(\d+)$/.exec(u.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

// 근거 없는 사실, 잘못된 코드 위치를 버리고 빈칸 문구를 정리한다.
// 목록 밖의 코드 표시 방식은 after, 빈칸 종류는 detail 로 바꾼다.
// 빈칸은 길이별 상한(BLANK_LIMIT)까지만 앞에서부터 남긴다. 재료가 없는 절은 작성 단계가 이웃 절과 합치므로 빈칸을 더하지 않는다.
// 다만 글 전체에 사실·코드·빈칸이 하나도 없으면 본문을 쓸 수 없으므로 첫 절에 detail 빈칸 하나를 둔다.
export const validateAnalysis = (
  analysis: RawAnalysis,
  ctx: {
    plan: Plan;
    hunks: Map<string, PreparedHunk>;
    commitIds: Set<string>;
    linkIds: Set<string>;
    blankDefaults: Record<BlankKind, string>;
    length: string;
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
    .map((pick) => ({ ...pick, mode: toCodeMode(pick.mode) }));

  const unknowns = analysis.unknowns
    .filter((unknown) => inRange(unknown.section))
    .slice(0, blankLimit(ctx.length))
    .map((unknown) => {
      const kind = toBlankKind(unknown.kind);
      return {
        ...unknown,
        kind,
        ask: sanitizeHint(unknown.ask) || ctx.blankDefaults[kind],
      };
    });

  if (sectionCount > 0 && facts.length + code.length + unknowns.length === 0) {
    unknowns.push({
      id: `U${maxUnknownNumber(analysis.unknowns) + 1}`,
      section: 0,
      kind: 'detail',
      ask: ctx.blankDefaults.detail,
    });
  }

  return { facts, code, unknowns };
};
