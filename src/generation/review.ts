import { z } from 'zod';

import { unwrapOuterFence } from './assemble.ts';
import { MAX_REVIEW_ISSUES, REVIEW_FIX_MAX } from './limits.ts';

export const REVIEW_KINDS = ['unknown_term', 'request_echo', 'link_context', 'unsupported', 'voice', 'flow'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];

// 모델 출력은 kind 를 문자열로 받고, 목록 밖 값은 validateReview 에서 버린다
export const ReviewSchema = z.object({
  issues: z.array(z.object({ kind: z.string(), quote: z.string(), fix: z.string() })),
});
export type RawReview = z.infer<typeof ReviewSchema>;

export interface ReviewIssue {
  kind: ReviewKind;
  quote: string;
  fix: string;
}

// assemble 의 자리표시자와 같은 모양 (안쪽 공백 허용)
const PLACEHOLDER = /\{\{\s*(code|link|ask)\s*:\s*([A-Z]\d+)\s*\}\}/g;

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

const isKind = (kind: string): kind is ReviewKind => (REVIEW_KINDS as readonly string[]).includes(kind);

// 초안에 실제로 있는 quote 만 남긴다 (모델이 지어낸 인용 제거)
export const validateReview = (raw: RawReview, draft: string): ReviewIssue[] => {
  const flatDraft = collapse(draft);
  const seen = new Set<string>();
  const issues: ReviewIssue[] = [];
  for (const item of raw.issues) {
    if (!isKind(item.kind)) continue;
    // 프롬프트 입력에서 escape 한 `<` 를 모델이 그대로 베낀 경우를 되돌린다
    const restored = item.quote.replaceAll('&lt;', '<');
    const quote = collapse(restored);
    const fix = item.fix.trim().slice(0, REVIEW_FIX_MAX).trim();
    if (!quote || !fix || seen.has(quote)) continue;
    if (!collapse(quote.replace(PLACEHOLDER, '')) || !flatDraft.includes(quote)) continue;
    seen.add(quote);
    issues.push({ kind: item.kind, quote: restored, fix });
    if (issues.length >= MAX_REVIEW_ISSUES) break;
  }
  return issues;
};

// 종류별 자리표시자 번호를 센다 (예: "code:S1" -> 횟수)
const countPlaceholders = (text: string, kinds: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const [, kind, id] of text.matchAll(PLACEHOLDER)) {
    if (!kinds.includes(kind)) continue;
    const key = `${kind}:${id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
};

const sameCounts = (a: Map<string, number>, b: Map<string, number>): boolean =>
  a.size === b.size && [...a].every(([key, n]) => b.get(key) === n);

// 제목 수준(#의 개수) 순서 (자리표시자 초안에는 코드 펜스가 없어 줄 단위로 읽는다)
const headingLevels = (text: string): number[] =>
  text.split('\n').flatMap((line) => {
    const match = /^(#{1,6})(?=\s|$)/.exec(line);
    return match ? [match[1].length] : [];
  });

const sameLevels = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((level, i) => level === b[i]);

// 고쳐 쓴 초안을 거절한 이유 (다시 고쳐 쓸 때 모델에게 알려 준다)
// placeholders: 횟수가 달라진 code·ask 자리표시자, 또는 입력에 없는 link 자리표시자 ({{kind:ID}} 모양, 정렬)
export const REVISION_PROBLEM_KINDS = ['empty', 'no_title', 'placeholders', 'headings', 'unknown_link'] as const;
export type RevisionProblemKind = (typeof REVISION_PROBLEM_KINDS)[number];

export interface RevisionProblem {
  kind: RevisionProblemKind;
  placeholders: string[];
}

export type RevisionCheck = { markdown: string } | { problem: RevisionProblem };

const toPlaceholder = (key: string): string => `{{${key}}}`;

const problem = (kind: RevisionProblemKind, keys: string[] = []): RevisionCheck => ({
  problem: { kind, placeholders: keys.map(toPlaceholder).sort() },
});

// 고쳐 쓴 초안이 안전하면 (바깥 펜스를 푼) 본문을, 아니면 거절 이유를 돌려준다
export const checkRevision = (draft: string, revised: string, linkIds: Set<string>): RevisionCheck => {
  const text = unwrapOuterFence(revised);
  if (!text.trim()) return problem('empty');
  if (!text.trimStart().startsWith('# ')) return problem('no_title');

  const before = countPlaceholders(draft, ['code', 'ask']);
  const after = countPlaceholders(text, ['code', 'ask']);
  if (!sameCounts(before, after)) {
    const keys = new Set([...before.keys(), ...after.keys()]);
    return problem('placeholders', [...keys].filter((key) => before.get(key) !== after.get(key)));
  }

  if (!sameLevels(headingLevels(draft), headingLevels(text))) return problem('headings');

  const unknown = [...countPlaceholders(text, ['link']).keys()].filter(
    (key) => !linkIds.has(key.slice('link:'.length)),
  );
  if (unknown.length > 0) return problem('unknown_link', unknown);

  return { markdown: text };
};
