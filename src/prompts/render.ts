import type { JobContext } from '../jobs.ts';
import type { PreparedLink } from '../generation/links.ts';
import { estimateTokens, LINK_PREVIEW_CHARS, PLAN_CATALOG_TOKENS } from '../generation/limits.ts';
import type { PreparedCommit, PreparedFile, PreparedHunk } from '../generation/prepare.ts';
import type { Analysis, Plan } from '../generation/schemas.ts';
import type { StoredAnalysis } from '../generation/stored-analysis.ts';
import {
  LENGTHS,
  POST_TYPES,
  REQUIRED_BLOCKS,
  TONES,
  type Length,
  type PostType,
  type RequiredBlock,
  type Tone,
} from './types.ts';

/**
 * 프롬프트에 넣는 데이터를 태그로 감싸는 함수 (언어와 무관)
 * - 모델은 태그 안을 데이터로만 다루도록 지시받는다
 * - 원문(요청, 커밋, 코드, 링크, 앞 단계 모델 출력)이 이 파이프라인의 태그를 열거나 닫는 척하지 못하게,
 *   태그 이름으로 시작하는 `<` 만 `&lt;` 로 바꾼다. `<div>`, `a < b` 같은 보통 코드는 그대로 둔다.
 */

// 렌더러가 내보내는 태그 이름. element/inline 은 이 이름만 받으므로 목록이 실제 출력과 어긋나지 않는다.
const TAGS = [
  'request', 'commit', 'message', 'files', 'hunk', 'link', 'links', 'title', 'text', 'plan',
  'section', 'heading', 'purpose', 'hunks', 'takeaway', 'outline', 'fact', 'code', 'point',
  'source', 'blank', 'context', 'analysis', 'question', 'answer',
] as const;
type Tag = (typeof TAGS)[number];

// `<`, 선택적 `/`, 태그 이름(대소문자 무시), 그 뒤가 이름 글자가 아닌 경우
const TAG_OPEN = new RegExp(`<(?=/?(?:${TAGS.join('|')})(?![\\w.:-]))`, 'gi');

export const escapeTagText = (text: string): string => text.replace(TAG_OPEN, '&lt;');

const escapeAttr = (value: string): string =>
  value.replace(/[&"<>]/g, (ch) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch);

const attrs = (values: Record<string, string | undefined>): string =>
  Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => ` ${key}="${escapeAttr(value)}"`)
    .join('');

// body 는 이미 탈출시킨 텍스트나 다른 태그여야 한다
const element = (tag: Tag, values: Record<string, string | undefined>, body: string): string =>
  `<${tag}${attrs(values)}>\n${body}\n</${tag}>`;

// 한 줄짜리 원문을 태그로 감싼다
const inline = (tag: Tag, values: Record<string, string | undefined>, text: string): string =>
  `<${tag}${attrs(values)}>${escapeTagText(text)}</${tag}>`;

const pick = <T extends string>(values: readonly T[], value: string, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

export interface ResolvedOptions {
  tone: Tone;
  postType: PostType;
  length: Length;
  requiredBlocks: RequiredBlock[];
}

// 알 수 없는 옵션 값은 기본값으로, 필수 블록은 아는 값만 정해진 순서로 남긴다
export const resolveOptions = (context: JobContext): ResolvedOptions => ({
  tone: pick(TONES, context.tone, 'plain'),
  postType: pick(POST_TYPES, context.postType, 'experience'),
  length: pick(LENGTHS, context.length, 'medium'),
  requiredBlocks: REQUIRED_BLOCKS.filter((block) => context.requiredBlocks.includes(block)),
});

export const tagRequest = (text: string): string => element('request', {}, escapeTagText(text));

// ---- 기획 단계: 커밋 카탈로그 ----

const fileLine = (file: PreparedFile, collapsed: boolean): string => {
  const line = `${file.id} ${file.status} ${escapeTagText(file.filename)} +${file.additions} -${file.deletions} [${file.body}]`;
  return collapsed && file.hunks.length > 0 ? `${line} (+${file.hunks.length} hunks)` : line;
};

const hunkLine = (hunk: PreparedHunk): string =>
  `  ${hunk.id} ${hunk.redacted ? '[redacted] ' : ''}${escapeTagText(hunk.header)}`;

const renderCatalogCommit = (commit: PreparedCommit, collapsed: boolean): string => {
  const files = commit.files.flatMap((file) => [
    fileLine(file, collapsed),
    ...(collapsed ? [] : file.hunks.map(hunkLine)),
  ]);
  return element(
    'commit',
    { id: commit.id },
    [
      element('message', {}, escapeTagText(commit.message)),
      element('files', {}, files.join('\n')),
    ].join('\n'),
  );
};

// 커밋별 파일 줄과 hunk `@@` 줄. 상한을 넘으면 가장 최근 커밋(배열 끝, 큰 C 번호)부터 hunk 줄을 생략한다.
export const renderCatalog = (commits: PreparedCommit[]): string => {
  const collapsed = new Set<number>();
  const render = (): string =>
    commits.map((commit, i) => renderCatalogCommit(commit, collapsed.has(i))).join('\n');
  let text = render();
  for (let i = commits.length - 1; i >= 0 && estimateTokens(text) > PLAN_CATALOG_TOKENS; i -= 1) {
    collapsed.add(i);
    text = render();
  }
  return text;
};

// ---- 분석 단계: 기획, 커밋 메시지, hunk 원문 ----

// available 을 주면 각 절의 hunk 번호를 실제로 넘긴 hunk 로 걸러, 읽지 않은 hunk 를 근거로 쓰지 못하게 한다
export const renderPlan = (plan: Plan, available?: Set<string>): string =>
  element(
    'plan',
    {},
    [
      inline('title', {}, plan.title),
      inline('takeaway', {}, plan.takeaway),
      ...plan.sections.map((section, index) =>
        element(
          'section',
          { index: String(index), level: String(section.level) },
          [
            inline('heading', {}, section.heading),
            inline('purpose', {}, section.purpose),
            inline(
              'hunks',
              {},
              section.hunks.filter((id) => !available || available.has(id)).join(', '),
            ),
            inline('links', {}, section.links.join(', ')),
          ].join('\n'),
        ),
      ),
    ].join('\n'),
  );

export const renderCommitMessages = (commits: PreparedCommit[]): string =>
  commits.map((commit) => element('commit', { id: commit.id }, escapeTagText(commit.message))).join('\n');

// 파일 번호(C1.F2) → 경로
export const fileNames = (commits: PreparedCommit[]): Map<string, string> =>
  new Map(commits.flatMap((commit) => commit.files.map((file) => [file.id, file.filename] as const)));

const fileIdOf = (hunkId: string): string => hunkId.replace(/\.H\d+$/, '');

// hunk 원문. 각 줄 앞에 hunk 안 줄 번호(1부터)를 붙인다. `@@` 줄에는 번호가 없다.
export const renderHunks = (hunks: PreparedHunk[], files: Map<string, string> = new Map()): string =>
  hunks
    .map((hunk) => {
      const width = String(hunk.lines.length).length;
      const lines = hunk.lines.map(
        (line, i) => `${String(i + 1).padStart(width)} | ${escapeTagText(line)}`,
      );
      return element(
        'hunk',
        { id: hunk.id, lang: hunk.language, file: files.get(fileIdOf(hunk.id)) },
        [escapeTagText(hunk.header), ...lines].join('\n'),
      );
    })
    .join('\n');

const preview = (text: string): string => {
  const chars = Array.from(text);
  return chars.length > LINK_PREVIEW_CHARS
    ? `${chars.slice(0, LINK_PREVIEW_CHARS).join('')}…`
    : text;
};

// 참고 링크의 제목과 본문 (기획 단계는 앞부분만). URL 은 모델이 옮겨 쓰지 않도록 넣지 않는다.
export const renderLinks = (links: PreparedLink[], options: { preview: boolean }): string =>
  links
    .map((link) =>
      element(
        'link',
        { id: link.id },
        [
          inline('title', {}, link.title),
          element('text', {}, escapeTagText(options.preview ? preview(link.text) : link.text)),
        ].join('\n'),
      ),
    )
    .join('\n');

// ---- 작성 단계: 절마다 사실, 코드, 빈칸을 모은 글 재료 ----

export const renderLinkTitles = (links: PreparedLink[]): string =>
  element('links', {}, links.map((link) => inline('link', { id: link.id }, link.title)).join('\n'));

// 코드 조각의 실제 줄 (작성 프롬프트와 조립이 함께 쓴다)
// after 는 삭제 줄을 빼고 접두사를 떼고, diff 는 접두사를 그대로 둔다. 줄 번호는 hunk 안에서 1부터, 양끝 포함.
export const buildCodeLines = (
  hunk: PreparedHunk,
  startLine: number,
  endLine: number,
  mode: Analysis['code'][number]['mode'],
): string[] => {
  const lines = hunk.lines.slice(startLine - 1, endLine);
  return mode === 'diff'
    ? lines
    : lines.filter((line) => !line.startsWith('-')).map((line) => line.slice(1));
};

// 사실의 링크 출처. 커밋 출처는 분석 단계의 내부 근거로만 쓰고 작성 단계에 넘기지 않는다
// (본문에 커밋 해시나 출처 문장이 들어가지 않게 하기 위해서다).
const factLinks = (evidence: string[]): string =>
  [...new Set(evidence.filter((id) => id.startsWith('L')))].join(' ');

const renderSection = (
  index: number,
  section: Plan['sections'][number],
  analysis: Analysis,
  hunks: Map<string, PreparedHunk>,
): string => {
  const facts = analysis.facts
    .filter((fact) => fact.section === index)
    .map((fact) =>
      inline(
        'fact',
        { id: fact.id, links: factLinks(fact.evidence) },
        fact.text,
      ),
    );
  const code = analysis.code
    .filter((pick) => pick.section === index && hunks.has(pick.from))
    .map((pick) => {
      const hunk = hunks.get(pick.from) as PreparedHunk;
      return element(
        'code',
        { id: pick.id, lang: pick.mode === 'diff' ? 'diff' : hunk.language, mode: pick.mode },
        [
          inline('point', {}, pick.point),
          element('source', {}, escapeTagText(buildCodeLines(hunk, pick.startLine, pick.endLine, pick.mode).join('\n'))),
        ].join('\n'),
      );
    });
  const blanks = analysis.unknowns
    .filter((unknown) => unknown.section === index)
    .map((unknown) => inline('blank', { id: unknown.id, kind: unknown.kind }, unknown.ask));

  return element(
    'section',
    { index: String(index), level: String(section.level) },
    [
      inline('heading', {}, section.heading),
      inline('purpose', {}, section.purpose),
      ...facts,
      ...code,
      ...blanks,
    ].join('\n'),
  );
};

export const renderOutline = (
  plan: Plan,
  analysis: Analysis,
  hunks: Map<string, PreparedHunk>,
): string =>
  element(
    'outline',
    {},
    [
      inline('title', {}, plan.title),
      inline('takeaway', {}, plan.takeaway),
      ...plan.sections.map((section, index) => renderSection(index, section, analysis, hunks)),
    ].join('\n'),
  );

// ---- 빈칸 채우기: 지금 본문, 저장한 분석, 질문, 답 ----

// 지금 본문 Markdown. 채울 자리는 {{target}} 한 줄로 이미 표시돼 있다.
export const renderFillContext = (markdown: string): string =>
  element('context', {}, escapeTagText(markdown));

// 저장한 분석. 재료가 하나도 없으면 빈 문자열 (프롬프트가 없음 안내로 바꿈)
export const renderStoredAnalysis = (analysis: StoredAnalysis | null): string => {
  const sections = (analysis?.sections ?? []).filter(
    (section) => section.facts.length + section.points.length + section.questions.length > 0,
  );
  if (sections.length === 0) return '';
  return element(
    'analysis',
    {},
    sections
      .map((section) =>
        element(
          'section',
          {},
          [
            inline('heading', {}, section.heading),
            ...section.facts.map((fact) => inline('fact', {}, fact)),
            ...section.points.map((point) => inline('point', {}, point)),
            ...section.questions.map((question) => inline('blank', {}, question)),
          ].join('\n'),
        ),
      )
      .join('\n'),
  );
};

export const renderFillQuestion = (question: string): string => inline('question', {}, question);

export const renderFillAnswer = (answer: string): string =>
  element('answer', {}, escapeTagText(answer));

