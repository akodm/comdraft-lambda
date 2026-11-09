import { GenerationFailure } from '../errors.ts';
import { buildCodeLines } from '../prompts/render.ts';
import type { PreparedLink } from './links.ts';
import type { PreparedCommit, PreparedHunk } from './prepare.ts';
import type { Analysis } from './schemas.ts';
import { containsSecret } from './secrets.ts';
import { sanitizeHint } from './validate.ts';

export interface AssembleInput {
  markdown: string;
  analysis: Analysis;
  commits: PreparedCommit[];
  hunks: Map<string, PreparedHunk>;
  links: PreparedLink[];
  request: string;
  referencesHeading: string;
}

// 모델이 쓴 자리표시자. 이 패턴에 맞는 것만 다루고 나머지 중괄호 글자는 그대로 둔다.
const PLACEHOLDER = /\{\{\s*(code|commit|link|ask)\s*:\s*([A-Z]\d+)\s*\}\}/g;

// 치환한 블록(코드, 빈칸)을 끝까지 보호하는 표지. 모델 글에 같은 문자가 있으면 먼저 지운다.
const MARK_OPEN = '';
const MARK_CLOSE = '';
const MARK_PATTERN = /(\d+)/g;
const MARK_CHARS = /[]/g;

const fail = (): never => {
  throw new GenerationFailure('invalid_result');
};

// 1단계: 모델이 쓴 fenced 코드 블록을 통째로 지운다. 닫히지 않으면 끝까지 지운다.
export const stripFencedBlocks = (text: string): string => {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    if (fence) {
      const close = new RegExp(`^ {0,3}(${fence.char}{${fence.length},})[ \\t]*$`).exec(line);
      if (close) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // 한 줄 안에서 닫히는 ```x``` 는 인라인 코드이므로 울타리가 아니다.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
};

// 2단계: 링크, 이미지, 맨 URL, HTML 을 지운다. 링크는 글자만 남긴다.
const URL_PARENS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
const stripMarkup = (text: string): string =>
  text
    .replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gm, '')
    .replace(/!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g, '')
    .replace(new RegExp(String.raw`\[([^\]]*)\]${URL_PARENS}`, 'g'), '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<[A-Za-z][A-Za-z0-9+.-]*:[^\s<>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?[A-Za-z][^<>]*>/g, '')
    .replace(/https?:\/\/[^\s<>)\]]+/gi, '')
    .replace(/\(\s*\)/g, '');

// 인라인 코드 조각 (한 단락 안, 같은 길이의 백틱으로 닫힘)
const CODE_SPAN = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?[^`])\1(?!`)/g;

const evidenceCorpus = (input: AssembleInput): string => {
  const parts: string[] = [input.request];
  const addHunk = (hunk: PreparedHunk): void => {
    parts.push(...hunk.lines);
  };
  for (const commit of input.commits) {
    parts.push(commit.message);
    for (const file of commit.files) {
      parts.push(file.filename);
      file.hunks.forEach(addHunk);
    }
  }
  input.hunks.forEach(addHunk);
  for (const link of input.links) parts.push(link.title, link.text);
  return parts.join('\n');
};

// 2~3단계: 인라인 코드 조각을 빼 두고 링크·URL·HTML 을 지운 뒤, 근거 없는 조각은 백틱을 벗겨 되돌린다.
const cleanProse = (text: string, corpus: string): string => {
  const spans: string[] = [];
  const stashed = text.replace(CODE_SPAN, (whole, _ticks: string, content: string) => {
    const trimmed = content.trim();
    const grounded = trimmed !== '' && corpus.includes(trimmed);
    spans.push(grounded ? whole : stripMarkup(content));
    return `${MARK_OPEN}s${spans.length - 1}${MARK_CLOSE}`;
  });
  return stripMarkup(stashed).replace(
    /s(\d+)/g,
    (_whole, index: string) => spans[Number(index)],
  );
};

// 링크 글자에서 Markdown 을 깨는 문자를 이스케이프한다.
const escapeLinkText = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');

const safeUrl = (url: string): string =>
  url.replace(/[\s()<>]/g, (c) => encodeURIComponent(c));

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

const formatLink = (link: PreparedLink): string => {
  const text = escapeLinkText(link.title) || escapeLinkText(hostnameOf(link.url)) || 'link';
  return `[${text}](${safeUrl(link.url)})`;
};

const formatCommit = (commit: PreparedCommit): string =>
  `[${commit.sha.slice(0, 7)}](${safeUrl(commit.htmlUrl)})`;

// 코드 안의 어떤 백틱 묶음보다 긴 울타리 (최소 3)
const fenceFor = (code: string): string => {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
};

const renderCode = (id: string, input: AssembleInput): string | null => {
  const pick = input.analysis.code.find((c) => c.id === id);
  const hunk = pick ? input.hunks.get(pick.from) : undefined;
  if (!pick || !hunk || hunk.redacted) return null;
  const lines = buildCodeLines(hunk, pick.startLine, pick.endLine, pick.mode);
  if (lines.length === 0) return null;
  const code = lines.join('\n');
  if (containsSecret(code)) return null;
  const fence = fenceFor(code);
  const language = pick.mode === 'diff' ? 'diff' : hunk.language;
  return `${fence}${language}\n${code}\n${fence}`;
};

const renderBlank = (id: string, input: AssembleInput): string | null => {
  const unknown = input.analysis.unknowns.find((u) => u.id === id);
  if (!unknown) return null;
  return `:::blank {kind="${unknown.kind}" hint="${sanitizeHint(unknown.ask)}"}\n:::`;
};

const linkNumber = (link: PreparedLink): number => Number(link.id.slice(1));

// 4~5단계: 블록형은 표지로 바꿔 독립 블록으로 빼고, 인라인형은 그 자리에서 바꾼다.
const substitute = (
  text: string,
  input: AssembleInput,
): { text: string; blocks: string[]; cited: Set<string> } => {
  const blocks: string[] = [];
  const cited = new Set<string>();
  const replaced = text.replace(PLACEHOLDER, (_whole, kind: string, id: string) => {
    if (kind === 'commit') {
      const commit = input.commits.find((c) => c.id === id);
      return commit ? formatCommit(commit) : '';
    }
    if (kind === 'link') {
      const link = input.links.find((l) => l.id === id);
      if (!link) return '';
      cited.add(link.id);
      return formatLink(link);
    }
    const block = kind === 'code' ? renderCode(id, input) : renderBlank(id, input);
    if (block === null) return '';
    blocks.push(block);
    return `\n\n${MARK_OPEN}${blocks.length - 1}${MARK_CLOSE}\n\n`;
  });
  return { text: replaced, blocks, cited };
};

// 7단계: 첫 블록은 H1, 이후 H1 은 H2 로 낮춘다. 본문이 비면 실패한다.
const normalizeHeadings = (text: string): string => {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0 || !/^ {0,3}#[ \t]+\S/.test(lines[first])) return fail();
  const body = lines.slice(first + 1);
  if (!body.some((line) => line.trim() !== '')) return fail();
  const lowered = body.map((line) => line.replace(/^( {0,3})#(?=[ \t])/, '$1##'));
  return [...lines.slice(0, first + 1), ...lowered].join('\n');
};

const renderReferences = (links: PreparedLink[], cited: Set<string>, heading: string): string => {
  const used = links.filter((link) => cited.has(link.id)).sort((a, b) => linkNumber(a) - linkNumber(b));
  if (used.length === 0) return '';
  return `\n\n## ${heading}\n\n${used.map((link) => `- ${formatLink(link)}`).join('\n')}`;
};

// 작성 모델의 Markdown 을 최종 초안으로 만든다. 모델이 쓸 수 없는 것은 지우고, 코드·URL·빈칸은 우리가 넣는다.
export const assemble = (input: AssembleInput): string => {
  const raw = input.markdown.replace(/\r\n?/g, '\n').replace(MARK_CHARS, '');
  const prose = cleanProse(stripFencedBlocks(raw), evidenceCorpus(input));
  const { text, blocks, cited } = substitute(prose, input);
  const tidy = text
    .replace(/[ \t]+$/gm, '')
    .replace(/(\uE001\n\n)[ \t]+/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
  const checked = normalizeHeadings(tidy);
  const resolved = checked.replace(MARK_PATTERN, (_whole, index: string) => blocks[Number(index)]);
  return resolved + renderReferences(input.links, cited, input.referencesHeading);
};
