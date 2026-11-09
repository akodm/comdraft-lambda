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

// 링크 글자에서 Markdown 을 깨는 문자를 이스케이프한다.
const escapeLinkText = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().replace(/[\\[\]<>`*_]/g, '\\$&');

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

// 모델이 쓴 글은 지우지 않고 이스케이프해서 링크, 이미지, HTML, 코드 블록, 지시문을 만들 수 없게 한다.
// 줄 맨 앞에서 한 글자만 이스케이프해야 하는 곳에 두는 임시 표지 (escapeProse 가 `\` 로 바꾼다).
const ESC_MARK = '\uE002';
// 줄머리 인용 표시(>)는 이스케이프하지 않도록 두는 표지 (escapeProse 가 `>` 로 되돌린다).
const QUOTE_MARK = '\uE003';
// 줄머리 공백의 칸 수 (탭은 다음 4의 배수 칸까지)
const takeIndent = (text: string, col: number): { width: number; length: number } => {
  let width = 0;
  let length = 0;
  while (text[length] === ' ' || text[length] === '\t') {
    width += text[length] === ' ' ? 1 : 4 - ((col + width) % 4);
    length += 1;
  }
  return { width, length };
};

const LIST_MARKER = /^([-*+]|\d{1,9}[.)])(?=[ \t]|$)/;

// 열려 있는 컨테이너. 인용(>) 이거나 목록 항목(본문이 시작하는 칸 폭)
type Frame = { kind: 'quote' } | { kind: 'list'; width: number };

// D: 줄 단위로 컨테이너(인용, 목록)를 따라가며, 어느 줄도 바깥 컨테이너 본문 칸보다 4칸 이상 들여쓰지 못하게 해
// 들여쓰기 코드 블록을 막는다. 합법적인 중첩 목록, 목록 안 인용은 그대로 둔다.
// 울타리(~~~), 지시문(:::), setext 밑줄은 첫 글자를 이스케이프한다.
// 백틱 울타리는 아래 조각 분해에서 짝 없는 백틱이 글자로 남으며 함께 막힌다.
const neutralizeBlocks = (text: string): string => {
  let frames: Frame[] = [];
  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') return '';
      let out = '';
      let rest = line;
      // 1) 이어지는 컨테이너 맞추기
      let matched = 0;
      for (const frame of frames) {
        const { width, length } = takeIndent(rest, out.length);
        if (frame.kind === 'quote') {
          if (width > 3 || rest[length] !== '>') break;
          out += ' '.repeat(width) + QUOTE_MARK;
          rest = rest.slice(length + 1);
          if (rest[0] === ' ') {
            out += ' ';
            rest = rest.slice(1);
          }
        } else {
          if (width < frame.width) break;
          out += ' '.repeat(frame.width);
          rest = ' '.repeat(width - frame.width) + rest.slice(length);
        }
        matched += 1;
      }
      frames = frames.slice(0, matched);
      // 2) 남은 줄머리 공백을 3칸으로 줄이며 새 컨테이너 열기
      for (;;) {
        const { width, length } = takeIndent(rest, out.length);
        const indent = Math.min(width, 3);
        const body = rest.slice(length);
        if (body.startsWith('>')) {
          out += ' '.repeat(indent) + QUOTE_MARK;
          rest = body.slice(1);
          if (rest[0] === ' ') {
            out += ' ';
            rest = rest.slice(1);
          }
          frames.push({ kind: 'quote' });
          continue;
        }
        const marker = LIST_MARKER.exec(body)?.[0];
        if (marker) {
          const afterMarker = takeIndent(body.slice(marker.length), out.length + indent + marker.length);
          // 마커 뒤 공백이 5칸 이상이면 본문은 1칸 뒤에서 시작하고 나머지는 들여쓰기 코드가 된다.
          const gap = afterMarker.width >= 5 || body.length === marker.length ? 1 : afterMarker.width;
          out += ' '.repeat(indent) + marker + ' '.repeat(gap);
          rest = ' '.repeat(afterMarker.width - gap) + body.slice(marker.length + afterMarker.length);
          frames.push({ kind: 'list', width: marker.length + gap });
          if (body.length === marker.length) break;
          continue;
        }
        out += ' '.repeat(indent);
        rest = body;
        break;
      }
      if (/^(?:~{3,}|:{3,})/.test(rest) || /^=+[ \t]*$/.test(rest)) rest = ESC_MARK + rest;
      return out + rest;
    })
    .join('\n');
};

type Piece = { kind: 'prose' | 'code'; text: string };

// A: 한 줄 안에서 CommonMark 방식으로 인라인 코드 조각을 나눈다.
// 같은 길이의 백틱으로 닫힌 조각만 후보이고, 근거 있는 것만 그대로 두며 나머지는 글로 되돌린다.
const splitLine = (line: string, corpus: string): Piece[] => {
  const pieces: Piece[] = [];
  const addProse = (text: string): void => {
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'prose') last.text += text;
    else pieces.push({ kind: 'prose', text });
  };
  let i = 0;
  while (i < line.length) {
    const char = line[i];
    if (char === '\\') {
      addProse(char);
      i += 1;
      // 백슬래시 바로 뒤의 백틱 묶음은 통째로 글자
      const escaped = /^`+/.exec(line.slice(i))?.[0] ?? '';
      addProse(escaped);
      i += escaped.length;
      continue;
    }
    if (char !== '`') {
      addProse(char);
      i += 1;
      continue;
    }
    const open = /^`+/.exec(line.slice(i))?.[0] ?? '`';
    let close = -1;
    for (let j = i + open.length; j < line.length; ) {
      if (line[j] !== '`') {
        j += 1;
        continue;
      }
      const run = /^`+/.exec(line.slice(j))?.[0] ?? '`';
      if (run.length === open.length) {
        close = j;
        break;
      }
      j += run.length;
    }
    if (close < 0) {
      addProse(open);
      i += open.length;
      continue;
    }
    const content = line.slice(i + open.length, close);
    const trimmed = content.trim();
    if (trimmed !== '' && corpus.includes(trimmed)) {
      pieces.push({ kind: 'code', text: line.slice(i, close + open.length) });
    } else {
      addProse(content);
    }
    i = close + open.length;
  }
  return pieces;
};

// B: 링크·이미지·HTML·자동 링크를 만드는 문자를 이스케이프한다.
const escapeProse = (text: string): string =>
  text.replace(/[\\[\]<>`@]/g, '\\$&').replace(new RegExp(ESC_MARK, 'g'), '\\')
    .replace(new RegExp(QUOTE_MARK, 'g'), '>');

// C: 맨 URL 과 www 자동 링크를 지운다. 자리표시자, 백틱, 괄호 앞에서 멈춘다.
const URL_BODY = String.raw`[^\s<>()\[\]{}\\`+'`'+String.raw`]*`;
const BARE_URL = new RegExp(String.raw`(?:(?:https?|ftp):\/\/|www\.)` + URL_BODY, 'gi');
// 지운 자리가 이어 붙어 새 URL 이 생기지 않도록 더 지울 것이 없을 때까지 반복한다.
const stripUrls = (text: string): string => {
  let current = text;
  for (;;) {
    const next = current.replace(BARE_URL, '');
    if (next === current) return next;
    current = next;
  }
};

interface Substitution {
  blocks: string[];
  cited: Set<string>;
}

const placeholderText = (kind: string, id: string, input: AssembleInput, sub: Substitution): string => {
  if (kind === 'commit') {
    const commit = input.commits.find((c) => c.id === id);
    return commit ? formatCommit(commit) : '';
  }
  if (kind === 'link') {
    const link = input.links.find((l) => l.id === id);
    if (!link) return '';
    sub.cited.add(link.id);
    return formatLink(link);
  }
  const block = kind === 'code' ? renderCode(id, input) : renderBlank(id, input);
  if (block === null) return '';
  sub.blocks.push(block);
  return `\n\n${MARK_OPEN}${sub.blocks.length - 1}${MARK_CLOSE}\n\n`;
};

// 4~5단계: 글 조각에서 자리표시자는 치환하고(블록형은 표지로 독립 블록), 나머지 글자는 이스케이프한다.
const renderProse = (prose: string, input: AssembleInput, sub: Substitution): string => {
  const text = stripUrls(prose);
  let out = '';
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    out += escapeProse(text.slice(last, match.index));
    // 링크 바로 앞의 ! 는 이미지가 되므로 이스케이프한다.
    if ((match[1] === 'link' || match[1] === 'commit') && out.endsWith('!')) out = `${out.slice(0, -1)}\\!`;
    out += placeholderText(match[1], match[2], input, sub);
    last = match.index + match[0].length;
  }
  return out + escapeProse(text.slice(last));
};

const renderModelText = (
  raw: string,
  input: AssembleInput,
  sub: Substitution,
): string => {
  const corpus = evidenceCorpus(input);
  return neutralizeBlocks(raw)
    .split('\n')
    .map((line) =>
      splitLine(line, corpus)
        .map((piece) => (piece.kind === 'code' ? piece.text : renderProse(piece.text, input, sub)))
        .join(''),
    )
    .join('\n');
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

// 작성 모델의 Markdown 을 최종 초안으로 만든다. 모델이 쓴 글은 이스케이프로 무력화하고, 코드·URL·빈칸은 우리가 넣는다.
export const assemble = (input: AssembleInput): string => {
  const raw = input.markdown.replace(/\r\n?/g, '\n').replace(/[\uE000-\uE003]/g, '');
  const sub: Substitution = { blocks: [], cited: new Set() };
  const text = renderModelText(raw, input, sub);
  const tidy = text
    .replace(/[ \t]+$/gm, '')
    .replace(/(\uE001\n\n)[ \t]+/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const checked = normalizeHeadings(tidy);
  const resolved = checked.replace(MARK_PATTERN, (_whole, index: string) => sub.blocks[Number(index)]);
  return resolved + renderReferences(input.links, sub.cited, input.referencesHeading);
};
