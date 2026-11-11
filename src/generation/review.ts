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
    const quote = collapse(item.quote);
    const fix = item.fix.trim().slice(0, REVIEW_FIX_MAX).trim();
    if (!quote || !fix || seen.has(quote)) continue;
    if (!collapse(quote.replace(PLACEHOLDER, '')) || !flatDraft.includes(quote)) continue;
    seen.add(quote);
    issues.push({ kind: item.kind, quote: item.quote, fix });
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

// 고쳐 쓴 초안이 안전하면 (바깥 펜스를 푼) 본문을, 아니면 null 을 돌려준다
export const acceptRevision = (draft: string, revised: string, linkIds: Set<string>): string | null => {
  const text = unwrapOuterFence(revised);
  if (!text.trim() || !text.trimStart().startsWith('# ')) return null;
  if (!sameCounts(countPlaceholders(draft, ['code', 'ask']), countPlaceholders(text, ['code', 'ask']))) return null;
  for (const key of countPlaceholders(text, ['link']).keys()) {
    if (!linkIds.has(key.slice('link:'.length))) return null;
  }
  return text;
};
