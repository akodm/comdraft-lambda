import type { CommitDetail } from '../github.ts';
import {
  estimateTokens,
  HUNK_TOKEN_BUDGET,
  MAX_CATALOG_FILES_PER_COMMIT,
  MAX_HUNK_LINE_CHARS,
  MAX_HUNK_LINES,
  MAX_MESSAGE_CHARS,
  MAX_SELECTED_HUNKS,
  MESSAGE_REDACT_MARGIN,
} from './limits.ts';
import { containsSecret, isSecretFile, redactSecrets } from './secrets.ts';

export interface PreparedHunk {
  id: string;
  header: string;
  lines: string[];
  redacted: boolean;
  language: string;
}

export interface PreparedFile {
  id: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  body: 'included' | 'excluded' | 'missing' | 'secret';
  hunks: PreparedHunk[];
}

export interface PreparedCommit {
  id: string;
  sha: string;
  htmlUrl: string;
  message: string;
  files: PreparedFile[];
}

const REDACTED_LINE = '[가림]';
// 너무 긴 줄이 있어 본문을 넘기지 않은 hunk (코드·근거로 쓰지 못하게 가림과 같이 다룸)
const LONG_LINE_MARKER = '[긴 줄 생략]';

const LOCK_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'go.sum',
  'Cargo.lock',
  'poetry.lock',
  'composer.lock',
  'Gemfile.lock',
]);
const EXCLUDED_DIRS = new Set([
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'node_modules',
  'vendor',
  '__snapshots__',
]);
const EXCLUDED_SUFFIXES = ['.min.js', '.min.css', '.map', '.snap'];
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'pdf',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'jar', 'wasm', 'mp3', 'mp4', 'mov',
]);

const LANGUAGES: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', json: 'json', sql: 'sql',
  yaml: 'yaml', yml: 'yaml', md: 'md', css: 'css', scss: 'scss', html: 'html', sh: 'sh',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'kt', swift: 'swift', rb: 'rb', php: 'php',
};

const extensionOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
};

export const languageForFile = (filename: string): string =>
  LANGUAGES[extensionOf(filename)] ?? 'plaintext';

// lock, 빌드 결과물, minified, 스냅샷은 본문을 넘기지 않는다
const isExcludedFile = (filename: string): boolean => {
  const segments = filename.split('/');
  const base = segments[segments.length - 1];
  return (
    LOCK_FILES.has(base) ||
    segments.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir)) ||
    EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))
  );
};

const isBinaryFile = (filename: string): boolean => BINARY_EXTENSIONS.has(extensionOf(filename));

// patch 를 `@@ ... @@` 줄 기준으로 hunk 로 나눈다 (`\ No newline` 줄은 뺀다)
const splitPatch = (patch: string): Array<{ header: string; lines: string[] }> => {
  const hunks: Array<{ header: string; lines: string[] }> = [];
  for (const line of patch.split('\n')) {
    if (/^@@ .* @@/.test(line)) {
      hunks.push({ header: line, lines: [] });
    } else if (hunks.length > 0 && !line.startsWith('\\')) {
      hunks[hunks.length - 1].lines.push(line);
    }
  }
  return hunks;
};

const prepareHunks = (fileId: string, filename: string, patch: string): PreparedHunk[] => {
  const language = languageForFile(filename);
  return splitPatch(patch).map((raw, i) => {
    const id = `${fileId}.H${i + 1}`;
    const header = raw.header.slice(0, MAX_HUNK_LINE_CHARS);
    const headerSecret = containsSecret(header);
    const lines = raw.lines.slice(0, MAX_HUNK_LINES);

    // minified·생성 데이터처럼 긴 줄은 글로 설명할 코드가 아니고, 검사 비용만 큼
    if (lines.some((line) => line.length > MAX_HUNK_LINE_CHARS)) {
      return {
        id,
        header: headerSecret ? REDACTED_LINE : header,
        lines: [LONG_LINE_MARKER],
        redacted: true,
        language,
      };
    }

    const redacted = headerSecret || containsSecret(lines.join('\n'));
    return {
      id,
      header: headerSecret ? REDACTED_LINE : header,
      lines: redacted ? [REDACTED_LINE] : lines,
      redacted,
      language,
    };
  });
};

const prepareFile = (
  commitId: string,
  index: number,
  file: CommitDetail['files'][number],
): PreparedFile => {
  const id = `${commitId}.F${index + 1}`;
  const base = {
    id,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
  };
  if (isSecretFile(file.filename)) return { ...base, body: 'secret', hunks: [] };
  if (isExcludedFile(file.filename)) return { ...base, body: 'excluded', hunks: [] };
  if (isBinaryFile(file.filename) || !file.patch) return { ...base, body: 'missing', hunks: [] };
  return { ...base, body: 'included', hunks: prepareHunks(id, file.filename, file.patch) };
};

// 입력은 최신순이고, 번호는 오래된 커밋이 C1
export const prepareCommits = (commits: CommitDetail[]): PreparedCommit[] =>
  [...commits].reverse().map((commit, i) => {
    const id = `C${i + 1}`;
    return {
      id,
      sha: commit.sha,
      htmlUrl: commit.htmlUrl,
      // 여유를 두고 먼저 자른 뒤 가리고 다시 자름: 경계에 걸친 비밀값의 앞부분이 남지 않고,
      // 아주 긴 메시지도 검사할 길이가 일정함
      message: redactSecrets(
        commit.message.slice(0, MAX_MESSAGE_CHARS + MESSAGE_REDACT_MARGIN),
      ).slice(0, MAX_MESSAGE_CHARS),
      files: commit.files
        .slice(0, MAX_CATALOG_FILES_PER_COMMIT)
        .map((file, fileIndex) => prepareFile(id, fileIndex, file)),
    };
  });

export const indexHunks = (commits: PreparedCommit[]): Map<string, PreparedHunk> => {
  const index = new Map<string, PreparedHunk>();
  for (const commit of commits)
    for (const file of commit.files) for (const hunk of file.hunks) index.set(hunk.id, hunk);
  return index;
};

// 고른 순서를 지키며 개수·토큰 상한에 닿으면 멈춘다
export const selectHunks = (index: Map<string, PreparedHunk>, ids: string[]): PreparedHunk[] => {
  const selected: PreparedHunk[] = [];
  const seen = new Set<string>();
  let tokens = 0;
  for (const id of ids) {
    const hunk = index.get(id);
    if (!hunk || hunk.redacted || seen.has(id)) continue;
    const cost = estimateTokens(hunk.lines.join('\n'));
    if (selected.length >= MAX_SELECTED_HUNKS || tokens + cost > HUNK_TOKEN_BUDGET) break;
    seen.add(id);
    selected.push(hunk);
    tokens += cost;
  }
  return selected;
};
