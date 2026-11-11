import { Lexer, type Token } from 'marked';

import { GenerationFailure } from '../errors.ts';
import { buildCodeLines } from '../prompts/render.ts';
import { MAX_FILL_PARAGRAPHS } from './limits.ts';
import type { PreparedLink } from './links.ts';
import type { PreparedCommit, PreparedHunk } from './prepare.ts';
import type { Analysis } from './schemas.ts';
import { containsSecret } from './secrets.ts';
import { sanitizeHint } from './validate.ts';

export interface AssembleInput {
  markdown: string;
  analysis: Analysis;
  // 커밋 메시지·파일 경로·hunk 는 인라인 코드의 근거 확인에만 쓴다 (본문에 커밋 링크를 넣지 않는다)
  commits: PreparedCommit[];
  hunks: Map<string, PreparedHunk>;
  links: PreparedLink[];
  request: string;
  referencesHeading: string;
}

// 모델이 쓴 자리표시자. 이 패턴에 맞는 것만 다루고 나머지 중괄호 글자는 그대로 둔다.
// commit 은 더 이상 쓰라고 하지 않지만, 모델이 옛 문법을 쓰면 글자로 남지 않게 지운다.
const PLACEHOLDER = /\{\{\s*(code|commit|link|ask)\s*:\s*([A-Z]\d+)\s*\}\}/g;

// 치환한 내용을 끝까지 보호하는 표지 (사설 영역 문자). 모델 글에 같은 문자가 있으면 먼저 지운다.
const BLOCK_OPEN = ''; // 독립 블록(코드, 빈칸)
const BLOCK_CLOSE = '';
const QUOTE_MARK = ''; // 줄머리 인용 표시(>)
const LINK_OPEN = ''; // 인라인 링크(참고 링크)
const LINK_CLOSE = '';
const SPAN_OPEN = ''; // 근거 있는 인라인 코드 조각
const SPAN_CLOSE = '';
const MARKER_CHARS = /[-]/g;
const MARKER_PATTERN = /(\d+)|(\d+)|(\d+)/g;

// 표지가 가리키는 실제 내용
interface Store {
  blocks: string[];
  links: string[];
  spans: string[];
  cited: Set<string>;
}

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

// 링크 글자에서 Markdown 을 깨는 문자를 이스케이프한다. (| 는 표 칸 구분)
const escapeLinkText = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().replace(/[\\[\]<>`*_|]/g, '\\$&');

// 공백·꺾쇠·괄호를 퍼센트 인코딩한다. encodeURIComponent 는 ( ) 를 그대로 두므로 직접 바꾼다.
const URL_ESCAPES: Record<string, string> = { '(': '%28', ')': '%29' };
const safeUrl = (url: string): string =>
  url.replace(/[\s()<>]/g, (c) => URL_ESCAPES[c] ?? encodeURIComponent(c));

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


// ---- 모델 글 무력화: 아래 단계 순서가 중요하다 (앞 단계가 글을 바꾸므로 줄 단위 검사는 마지막에 한다) ----

type Piece = { kind: 'prose' | 'code'; text: string };

// b: 한 줄 안에서 CommonMark 방식으로 인라인 코드 조각을 나눈다.
// 같은 길이의 백틱으로 닫힌 조각만 후보이고, 근거 있는 것만 표지로 보호하며 나머지는 글로 되돌린다.
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

const protectSpans = (text: string, corpus: string, store: Store): string =>
  text
    .split('\n')
    .map((line) =>
      splitLine(line, corpus)
        .map((piece) => {
          if (piece.kind === 'prose') return piece.text;
          store.spans.push(piece.text);
          return `${SPAN_OPEN}${store.spans.length - 1}${SPAN_CLOSE}`;
        })
        .join(''),
    )
    .join('\n');

// c: 자리표시자를 표지로 바꾼다. 블록형은 독립 단락으로 빼고, 모르거나 실패한 것은 공백 하나로 바꿔 앞뒤 글이 이어 붙지 않게 한다.
// 커밋 자리표시자는 본문에 출처를 남기지 않도록 언제나 공백으로 지운다.
const substitutePlaceholders = (text: string, input: AssembleInput, store: Store): string =>
  text.replace(PLACEHOLDER, (_whole, kind: string, id: string) => {
    if (kind === 'commit') return ' ';
    if (kind === 'link') {
      const link = input.links.find((l) => l.id === id);
      if (!link) return ' ';
      store.cited.add(link.id);
      store.links.push(formatLink(link));
      return `${LINK_OPEN}${store.links.length - 1}${LINK_CLOSE}`;
    }
    const block = kind === 'code' ? renderCode(id, input) : renderBlank(id, input);
    if (block === null) return ' ';
    store.blocks.push(block);
    return `\n\n${BLOCK_OPEN}${store.blocks.length - 1}${BLOCK_CLOSE}\n\n`;
  });

// d: 맨 URL 과 www 자동 링크를 공백으로 바꾼다. 표지, 괄호, 백틱 앞에서 멈춘다.
const BARE_URL = new RegExp(
  String.raw`(?:(?:https?|ftp):\/\/|www\.)[^\s<>()\[\]{}\\` + '`' + String.raw`-]*`,
  'gi',
);
const stripUrls = (text: string): string => {
  let current = text;
  for (;;) {
    const next = current.replace(BARE_URL, ' ');
    if (next === current) return next;
    current = next;
  }
};

// e: 링크·이미지·HTML·자동 링크·이메일·표를 만드는 문자를 이스케이프한다. 줄머리 인용 표시(>)만 남겨 둔다.
// 표는 comdraft 편집기가 읽지 못해 통째로 사라지므로 칸 구분(|)도 글자로 만든다.
// 근거 있는 인라인 코드 안의 | 는 그대로지만 칸마다 백틱이 붙어 정렬 줄이 될 수 없다.
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|(?:[-*+]|\d{1,9}[.)])(?=[ \t])))*/;
const escapeProse = (text: string): string =>
  text
    .split('\n')
    .map((line) => {
      const prefix = CONTAINER_PREFIX.exec(line)?.[0] ?? '';
      const rest = line
        .slice(prefix.length)
        .replace(/[\\[\]<>@`|]/g, '\\$&')
        // 링크 바로 앞의 ! 는 이미지가 되므로 이스케이프한다.
        .replace(/!(?=)/g, '\\!');
      return prefix.replace(/>/g, QUOTE_MARK) + rest;
    })
    .join('\n');

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
const THEMATIC_BREAK = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

// 열려 있는 컨테이너. 인용(>) 이거나 목록 항목(본문이 시작하는 칸 폭)
type Frame = { kind: 'quote' } | { kind: 'list'; width: number };

// 목록 항목으로 볼 수 있는 마커인가. 확실한 것만 항목으로 보면 들여쓰기를 더 엄격하게 줄이는 쪽이라 안전하다.
// 빈 항목, 구분선, 단락을 끊지 못하는 1 이 아닌 번호는 항목으로 치지 않는다.
const isListItem = (marker: string, body: string, canStartAnywhere: boolean): boolean => {
  if (THEMATIC_BREAK.test(body)) return false;
  if (body.slice(marker.length).trim() === '') return false;
  const number = /^\d+/.exec(marker)?.[0];
  return number === undefined || Number(number) === 1 || canStartAnywhere;
};

// f: 줄 단위로 컨테이너(인용, 목록)를 따라가며, 어느 줄도 바깥 컨테이너 본문 칸보다 4칸 이상 들여쓰지 못하게 해
// 들여쓰기 코드 블록을 막는다. 합법적인 중첩 목록, 목록 안 인용은 그대로 둔다.
// 울타리(~~~), 지시문(:::), setext 밑줄은 첫 글자를 이스케이프한다.
const neutralizeLines = (text: string): string => {
  let frames: Frame[] = [];
  let previousBlank = true;
  return text
    .split('\n')
    .map((line) => {
      if (line.trim() === '') {
        previousBlank = true;
        return '';
      }
      const afterBlank = previousBlank;
      previousBlank = false;
      let out = '';
      let rest = line;
      // 1) 이어지는 컨테이너 맞추기
      let matched = 0;
      for (const frame of frames) {
        const { width, length } = takeIndent(rest, out.length);
        if (frame.kind === 'quote') {
          if (width > 3 || !rest.slice(length).startsWith(QUOTE_MARK)) break;
          out += `${' '.repeat(width)}>`;
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
      let opened = 0;
      for (;;) {
        const { width, length } = takeIndent(rest, out.length);
        const indent = Math.min(width, 3);
        const body = rest.slice(length);
        if (body.startsWith(QUOTE_MARK)) {
          out += `${' '.repeat(indent)}>`;
          rest = body.slice(1);
          if (rest[0] === ' ') {
            out += ' ';
            rest = rest.slice(1);
          }
          frames.push({ kind: 'quote' });
          opened += 1;
          continue;
        }
        const marker = LIST_MARKER.exec(body)?.[0];
        if (marker && isListItem(marker, body, afterBlank || opened > 0)) {
          const after = takeIndent(body.slice(marker.length), out.length + indent + marker.length);
          // 마커 뒤 공백이 5칸 이상이면 본문은 1칸 뒤에서 시작하고 나머지는 들여쓰기 코드가 된다.
          const gap = after.width >= 5 ? 1 : after.width;
          out += `${' '.repeat(indent)}${marker}${' '.repeat(gap)}`;
          rest = ' '.repeat(Math.max(0, after.width - gap)) + body.slice(marker.length + after.length);
          frames.push({ kind: 'list', width: marker.length + gap });
          opened += 1;
          continue;
        }
        out += ' '.repeat(indent);
        rest = body;
        break;
      }
      // 컨테이너로 쓰이지 못한 인용 표시는 글자로 남긴다.
      rest = rest.replace(//g, '\\>');
      // 콜론이 든 정렬 줄(:---, ---:)은 세로선 없이도 한 칸짜리 표를 만든다.
      const alignRow = /^:?-+:?[ \t]*$/.test(rest) && rest.includes(':');
      if (/^(?:~{3,}|:{3,})/.test(rest) || /^=+[ \t]*$/.test(rest) || alignRow) rest = `\\${rest}`;
      return out + rest;
    })
    .join('\n');
};

const tidy = (text: string): string =>
  text
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// g: 결과를 GFM 으로 읽어 코드 블록, HTML, 링크, 이미지, 정의, 표, 줄머리 울타리·지시문이 있는지 본다 (표지 자리는 평범한 글로 바꿔 읽는다).
const FORBIDDEN_TOKENS = new Set(['code', 'html', 'link', 'image', 'def', 'table']);
const hasForbiddenToken = (tokens: Token[] | undefined): boolean =>
  (tokens ?? []).some((token) => {
    const nested = token as unknown as {
      tokens?: Token[];
      items?: Token[];
      header?: { tokens: Token[] }[];
      rows?: { tokens: Token[] }[][];
    };
    return (
      FORBIDDEN_TOKENS.has(token.type) ||
      hasForbiddenToken(nested.tokens) ||
      hasForbiddenToken(nested.items) ||
      (nested.header ?? []).some((cell) => hasForbiddenToken(cell.tokens)) ||
      (nested.rows ?? []).some((row) => row.some((cell) => hasForbiddenToken(cell.tokens)))
    );
  });

const CONTAINER_THEN_SPACE = new RegExp(`${CONTAINER_PREFIX.source.slice(1)}[ \\t]*`);
const hasViolation = (laidOut: string): boolean => {
  const openers = laidOut.split('\n').some((line) => {
    const start = line.replace(new RegExp(`^${CONTAINER_THEN_SPACE.source}`), '');
    return /^(?:```|~~~|:::)/.test(start);
  });
  if (openers) return true;
  const neutral = laidOut
    .replace(/\d+/g, 'BLOCK')
    .replace(/\d+/g, 'LINK')
    .replace(/\d+/g, '`span`');
  try {
    return hasForbiddenToken(new Lexer({ gfm: true }).lex(neutral));
  } catch {
    return true;
  }
};

// 모든 줄의 앞 공백을 지워 컨테이너 중첩 없이 납작하게 만든다 (추적기가 틀렸을 때의 안전망).
const flatten = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/^[ \t]+/, ''))
    .join('\n');

const layOut = (escaped: string): string => tidy(neutralizeLines(escaped));

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
// 예상하지 못한 오류도 입력 내용 없이 invalid_result 로만 알린다.
export const assemble = (input: AssembleInput): string => {
  try {
    return assembleUnsafe(input);
  } catch (error) {
    throw error instanceof GenerationFailure ? error : new GenerationFailure('invalid_result');
  }
};

const assembleUnsafe = (input: AssembleInput): string => {
  const store: Store = { blocks: [], links: [], spans: [], cited: new Set() };
  const raw = input.markdown.replace(/\r\n?/g, '\n').replace(MARKER_CHARS, '');
  const withSpans = protectSpans(raw, evidenceCorpus(input), store);
  // 독립 블록 둘레의 공백은 블록 밖의 글머리 공백이 되지 않게 지운다.
  const substituted = substitutePlaceholders(withSpans, input, store).replace(
    /[ \t]*(\n\n\uE000\d+\uE001\n\n)[ \t]*/g,
    '$1',
  );
  const escaped = escapeProse(stripUrls(substituted));
  let laidOut = layOut(escaped);
  if (hasViolation(laidOut)) {
    laidOut = layOut(flatten(escaped));
    if (hasViolation(laidOut)) fail();
  }
  const checked = normalizeHeadings(laidOut);
  const resolved = checked.replace(
    MARKER_PATTERN,
    (_whole, block?: string, link?: string, span?: string) =>
      block !== undefined
        ? store.blocks[Number(block)]
        : link !== undefined
          ? store.links[Number(link)]
          : store.spans[Number(span)],
  );
  return resolved + renderReferences(input.links, store.cited, input.referencesHeading);
};


// ---- 빈칸 채우기 결과 정리: 조립과 같은 무력화를 거친 뒤 문단만 남긴다 ----

// 모델이 쓴 모든 {{…}} (빈칸 채우기 결과에는 어떤 자리표시자도 넣지 않는다)
const ANY_PLACEHOLDER = /\{\{[^{}\n]*\}\}/g;
const FENCE_OPEN = /^(`{3,}|~{3,})/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
// 제목, setext 밑줄, 구분선, 표 정렬 줄, 지시문(:::)
const DROPPED_LINE = [
  /^#{1,6}(?=[ \t]|$)/,
  /^(?:=+|:?-+:?)[ \t]*$/,
  /^(?:[-*_][ \t]*){3,}$/,
  /^:{3,}/,
];
// 줄머리의 인용 표시, 글머리 기호, 들여쓰기 (번호 목록 표시는 뒤에서 글자로 남긴다)
const LEADING_CONTAINER = /^(?:[ \t]*(?:>|[-*+](?=[ \t]|$)))*[ \t]*/;

// 글 전체를 감싼 바깥 펜스 (markdown·md 이거나 언어 없는 것만)
const OUTER_FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*(?:markdown|md)?[ \t]*$/i;

// 같은 울타리로 닫히는 줄인가 (같은 문자, 같거나 긴 길이)
const closesFence = (line: string, fence: string): boolean => {
  const close = FENCE_CLOSE.exec(line)?.[1];
  return Boolean(close && close[0] === fence[0] && close.length >= fence.length);
};

// 모델이 글 전체를 코드 펜스 하나로 감싸 보냈으면 펜스만 벗긴다 (안쪽은 그대로 정리를 거친다)
export const unwrapOuterFence = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').trim().split('\n');
  const fence = OUTER_FENCE_OPEN.exec(lines[0])?.[1];
  if (!fence || lines.length < 2 || !closesFence(lines[lines.length - 1], fence)) return markdown;
  const inner = lines.slice(1, -1);
  // 안에서 먼저 닫히면 펜스 하나로 감싼 글이 아니다 (코드 블록 여러 개)
  return inner.some((line) => closesFence(line, fence)) ? markdown : inner.join('\n');
};

// 코드 블록(울타리와 내용, 닫히지 않으면 끝까지)과 블록 요소 줄을 지운다. 줄머리는 이미 납작하다.
const dropBlockLines = (text: string): string => {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line)?.[1];
    if (open) {
      fence = open;
      continue;
    }
    if (DROPPED_LINE.some((pattern) => pattern.test(line))) continue;
    kept.push(line);
  }
  return kept.join('\n');
};

// 근거 있는 인라인 코드 조각 표지
const SPAN_MARKER = new RegExp(`${SPAN_OPEN}(\\d+)${SPAN_CLOSE}`, 'g');

// 문단(과 빈 줄)만 있고, 안에 코드·HTML·링크·이미지가 없는가
const isParagraphsOnly = (text: string): boolean => {
  if (/^(?:```|~~~|:::)/m.test(text)) return false;
  try {
    const tokens = new Lexer({ gfm: true }).lex(text.replace(SPAN_MARKER, '`span`'));
    return (
      tokens.every((token) => token.type === 'paragraph' || token.type === 'space') &&
      !hasForbiddenToken(tokens)
    );
  } catch {
    return false;
  }
};

/**
 * 빈칸 채우기 모델 출력 → 빈칸 자리에 넣을 Markdown 문단 1~3개
 * - 조립과 같은 무력화: 모델이 쓴 URL 은 지우고, 링크·이미지·HTML·표를 만드는 문자는 이스케이프한다
 * - 제목, 코드 블록, 구분선, 지시문 줄은 지우고, 목록·인용·들여쓰기는 문단 글자로 납작하게 만든다
 * - 인라인 코드는 근거(본문, 저장한 분석, 답)에 있는 것만 코드로 남긴다
 * - 남는 글이 없거나 문단 밖의 요소가 남으면 invalid_result
 * @param evidence 인라인 코드 근거로 인정하는 글
 */
export const sanitizeFill = (markdown: string, evidence: string): string => {
  try {
    return sanitizeFillUnsafe(markdown, evidence);
  } catch (error) {
    throw error instanceof GenerationFailure ? error : new GenerationFailure('invalid_result');
  }
};

const sanitizeFillUnsafe = (markdown: string, evidence: string): string => {
  const store: Store = { blocks: [], links: [], spans: [], cited: new Set() };
  const flat = unwrapOuterFence(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(MARKER_CHARS, '')
    .replace(ANY_PLACEHOLDER, ' ')
    .split('\n')
    .map((line) => line.replace(LEADING_CONTAINER, ''))
    .join('\n');
  const withSpans = protectSpans(dropBlockLines(flat), evidence, store);
  const escaped = escapeProse(stripUrls(withSpans))
    .split('\n')
    // 줄머리 공백은 위에서 지웠으므로 남은 컨테이너는 번호 목록 표시뿐이다. 점·괄호를 이스케이프해 글자로 둔다.
    .map((line) => line.replace(/^(\d{1,9})([.)])/, '$1\\$2').replace(new RegExp(QUOTE_MARK, 'g'), '\\>'))
    .join('\n');
  const paragraphs = tidy(escaped)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
    .slice(0, MAX_FILL_PARAGRAPHS);
  const text = paragraphs.join('\n\n');
  if (text === '' || !isParagraphsOnly(text)) fail();
  return text.replace(SPAN_MARKER, (_whole, span: string) => store.spans[Number(span)]);
};
