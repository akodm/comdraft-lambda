import type { Pipeline } from './pipeline.ts';

/**
 * [임시] LLM 없이 커밋 정보로 결과 뼈대를 만드는 파이프라인 (인프라 연결 확인용, 테스트에서 사용)
 */

// 변경 파일 목록 최대 표시 개수
const MAX_LISTED_FILES = 10;

const getSubject = (message: string) => message.split('\n')[0]?.trim() ?? '';

// 커밋 제목이 Markdown 문법으로 해석되지 않도록 특수 문자 이스케이프
const escapeMarkdown = (text: string) => {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
};

// [임시] LLM 없이 커밋 정보로 결과 뼈대를 만드는 단계 (인프라 연결 확인용)
export const createPlaceholderPipeline = (): Pipeline => ({
  // Claude 를 부르지 않으므로 준비물도 예상량도 없다
  prepare: async () => ({}),
  estimate: () => 0,
  classify: async ({ commits }) => commits.map(({ sha }) => sha),
  analyze: async (_input, classified) => classified,
  write: async ({ context, commits }) => {
    const ordered = [...commits].reverse();
    const title = getSubject(ordered[0]?.message ?? '') || context.prompt;
    const intro = context.prompt
      .split(/\n+/)
      .map((line) => escapeMarkdown(line.trim()))
      .filter(Boolean);

    const sections = ordered.map(({ sha, message, htmlUrl, files }) => {
      const listedFiles = files
        .slice(0, MAX_LISTED_FILES)
        .map(({ filename }) => filename);

      return [
        `## ${escapeMarkdown(getSubject(message))}`,
        `[\`${sha.slice(0, 7)}\`](${htmlUrl})`,
        ...(listedFiles.length > 0
          ? [['```text', ...listedFiles, '```'].join('\n')]
          : []),
      ].join('\n\n');
    });

    return [`# ${escapeMarkdown(title)}`, ...intro, ...sections].join('\n\n');
  },
  // 작성 결과가 곧 최종 Markdown 이라 검토 없이 그대로 돌려준다
  review: async (_input, written) => written as string,
});
