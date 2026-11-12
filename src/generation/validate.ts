import { validateClarify } from './clarify.ts';
import { CODE_LIMIT, MAX_CODE_LINES } from './limits.ts';
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
// 필수 블록의 제목 수준(h2~h6) 중 기획 절에 없는 수준 (작은 것부터). h1 은 글 제목이라 보지 않는다.
export const missingHeadingLevels = (plan: Plan, requiredBlocks: string[]): number[] => {
  const present = new Set(plan.sections.map((section) => section.level));
  return requiredBlocks
    .map((block) => /^h([2-6])$/.exec(block)?.[1])
    .filter((digit): digit is string => digit !== undefined)
    .map(Number)
    .filter((level) => !present.has(level))
    .sort((a, b) => a - b);
};

export const validatePlan = (
  plan: RawPlan,
  ctx: { hunkIds: Set<string>; linkIds: Set<string>; length: string },
): Plan => {
  const [, max] = sectionRange(ctx.length);
  const kept = plan.sections.slice(0, max);
  // 첫 절은 글 제목(h1) 바로 아래라 h2 여야 한다. 더 깊으면 모든 절을 같은 만큼 올려 상대 구조를 지킨다.
  const shift = Math.max(0, (kept[0]?.level ?? MIN_LEVEL) - MIN_LEVEL);
  let previousLevel = 0;
  const sections = kept.map((section) => {
    const upper =
      previousLevel === 0 ? MIN_LEVEL : Math.min(MAX_LEVEL, previousLevel + 1);
    const level = clamp(section.level - shift, MIN_LEVEL, upper);
    previousLevel = level;
    return {
      ...section,
      level,
      hunks: section.hunks.filter((id) => ctx.hunkIds.has(id)),
      links: section.links.filter((id) => ctx.linkIds.has(id)),
    };
  });
  return {
    ...plan,
    sections,
    linkRoles: validateLinkRoles(plan.linkRoles, ctx.linkIds),
    clarify: validateClarify(plan.clarify),
  };
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

type CodePick = RawAnalysis['code'][number];

// 따옴표 안의 글자는 괄호로 세지 않는다 (문자열 속 '{' 때문에 잘못 늘리지 않게)
const STRING_LITERAL = /(['"`])(?:\\.|(?!\1).)*\1/g;

// Rust 수명 표기('a, 'static)는 닫는 따옴표가 없어 문자열로 잘못 읽히므로 먼저 지운다 ('a' 같은 문자 리터럴은 남김)
const RUST_LIFETIME = /'[A-Za-z_]\w*(?!['\w])/g;
// Ruby 의 end 로 닫는 블록: 줄머리 키워드, 대입 오른쪽의 if·case 등, 줄 끝의 do (|인자| 포함)
const RUBY_OPENER = /^(?:def|class|module|if|unless|while|until|case|begin|for)\b|=\s*(?:if|unless|case|begin)\b|\bdo(?:\s*\|[^|]*\|)?\s*$/;
const RUBY_CLOSER = /^end\b/;
const RUBY_COMMENT = /\s#.*$|^#.*$/;

// 여는 괄호 수 - 닫는 괄호 수 (+, - 표시를 뗀 줄 기준, Ruby 는 end 로 닫는 블록도 센다)
const blockBalance = (lines: string[], language: string): number =>
  lines.reduce((balance, line) => {
    let code = line.slice(1);
    if (language === 'rs') code = code.replace(RUST_LIFETIME, '');
    code = code.replace(STRING_LITERAL, '');
    const opens = (code.match(/[{([]/g) ?? []).length;
    const closes = (code.match(/[})\]]/g) ?? []).length;
    if (language !== 'rb') return balance + opens - closes;
    const trimmed = code.replace(RUBY_COMMENT, '').trim();
    const keyword = (RUBY_OPENER.test(trimmed) ? 1 : 0) - (RUBY_CLOSER.test(trimmed) ? 1 : 0);
    return balance + opens - closes + keyword;
  }, 0);

// 글에 보이는 줄 (after 는 삭제 줄을 뺀다, buildCodeLines 와 같은 기준)
const visibleLines = (hunk: PreparedHunk, pick: CodePick, endLine: number): string[] => {
  const lines = hunk.lines.slice(pick.startLine - 1, endLine);
  return toCodeMode(pick.mode) === 'diff' ? lines : lines.filter((line) => !line.startsWith('-'));
};

// 앞 블록의 닫는 줄(`);`, `}`, Ruby 의 `end` 등)로 시작하는 조각은 그 줄들을 건너뛴다
// 여는 괄호가 나오기 전까지만 본다 (조각 끝에서 바깥 블록을 닫는 줄 때문에 본문을 버리지 않게)
const skipLeadingClosers = (pick: CodePick, hunks: Map<string, PreparedHunk>): CodePick => {
  const hunk = hunks.get(pick.from) as PreparedHunk;
  let balance = 0;
  let startLine = pick.startLine;
  for (let line = pick.startLine; line <= pick.endLine; line += 1) {
    balance += blockBalance([hunk.lines[line - 1]], hunk.language);
    if (balance > 0) break;
    if (balance < 0) {
      startLine = line + 1;
      balance = 0;
    }
  }
  return startLine <= pick.endLine ? { ...pick, startLine } : pick;
};

// 블록 중간에서 끝나는 조각은 괄호가 닫힐 때까지 끝줄을 늘린다 (hunk 끝과 MAX_CODE_LINES 안에서만, 못 닫으면 그대로)
const closeOpenBlock = (pick: CodePick, hunks: Map<string, PreparedHunk>): CodePick => {
  const hunk = hunks.get(pick.from) as PreparedHunk;
  if (blockBalance(visibleLines(hunk, pick, pick.endLine), hunk.language) <= 0) return pick;
  const lastLine = Math.min(hunk.lines.length, pick.startLine + MAX_CODE_LINES - 1);
  for (let endLine = pick.endLine + 1; endLine <= lastLine; endLine += 1) {
    if (blockBalance(visibleLines(hunk, pick, endLine), hunk.language) <= 0) return { ...pick, endLine };
  }
  return pick;
};

// 같은 hunk 에서 앞 조각과 줄 범위가 겹치는 조각을 버린다 (같은 코드가 글에 두 번 실리지 않게, 표시 방식과 무관)
const dropOverlappingPicks = (picks: CodePick[]): CodePick[] => {
  const kept: CodePick[] = [];
  for (const pick of picks) {
    const overlaps = kept.some(
      (other) =>
        other.from === pick.from &&
        pick.startLine <= other.endLine &&
        other.startLine <= pick.endLine,
    );
    if (!overlaps) kept.push(pick);
  }
  return kept;
};

// 요청에 적힌 소감·평가 (예: 편했다, 간단했다, easy to use) — 이미 글쓴이가 답한 내용이라 같은 것을 빈칸으로 다시 묻지 않는다
const IMPRESSION = /편하|편했|좋았|간단|만족|불편|아쉬|어려웠|쉬웠|\b(easy|convenient|liked|enjoyed|hard|difficult|painful)\b/i;
const PARTICLE = /(으로|에서|까지|부터|로|을|를|이|가|은|는|과|와|의|에|도|만)$/;
const contentWords = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((word) => word.replace(PARTICLE, ''))
      .filter((word) => word.length >= 2),
  );

// 결과·회고 빈칸이 요청의 소감과 같은 대상을 묻는지 (내용어 두 개 이상이 겹치면 같은 질문으로 본다)
const reasksImpression = (unknown: RawAnalysis['unknowns'][number], impressions: RawAnalysis['facts']): boolean => {
  const kind = toBlankKind(unknown.kind);
  if (kind !== 'result' && kind !== 'lesson') return false;
  const asked = contentWords(unknown.ask);
  return impressions.some((fact) => [...contentWords(fact.text)].filter((word) => asked.has(word)).length >= 2);
};

// 길이별 코드 조각 상한 (짧은 글에 코드가 본문보다 많아지지 않게, 앞에서부터 남긴다)
const keepCodeLimit = (picks: CodePick[], length: string): CodePick[] =>
  picks.slice(0, CODE_LIMIT[length as keyof typeof CODE_LIMIT] ?? CODE_LIMIT.medium);

const maxUnknownNumber = (unknowns: RawAnalysis['unknowns']): number =>
  unknowns.reduce((max, u) => {
    const match = /^U(\d+)$/.exec(u.id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

// 근거 없는 사실, 잘못된 코드 위치, 앞 조각과 겹치는 코드 위치를 버리고 빈칸 문구를 정리한다.
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

  const code = keepCodeLimit(
    dropOverlappingPicks(
      analysis.code
        .filter((pick) => inRange(pick.section) && isValidCodePick(pick, ctx.hunks))
        .map((pick) => closeOpenBlock(skipLeadingClosers(pick, ctx.hunks), ctx.hunks)),
    ),
    ctx.length,
  ).map((pick) => ({ ...pick, mode: toCodeMode(pick.mode) }));

  const impressions = facts.filter((fact) => fact.evidence.includes('R') && IMPRESSION.test(fact.text));
  const unknowns = analysis.unknowns
    .filter((unknown) => inRange(unknown.section))
    .filter((unknown) => !reasksImpression(unknown, impressions))
    .slice(0, blankLimit(ctx.length))
    .map((unknown) => {
      const kind = toBlankKind(unknown.kind);
      return {
        ...unknown,
        // 회고 빈칸은 글을 맺는 마지막 절에 둔다 (본문 중간에 회고 질문이 끼지 않게)
        section: kind === 'lesson' ? sectionCount - 1 : unknown.section,
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
