import type { CommitDetail } from './github.ts';
import type { JobContext } from './jobs.ts';

/**
 * 구분 → 분석 → 작성 단계
 * - 각 단계는 앞 단계 결과를 받아 메모리에서만 넘기고, 마지막 작성 결과(Markdown)만 저장됨
 * - 지금은 LLM 연동 전 임시 구현 (커밋 정보로 Markdown 뼈대만 만듦)
 *   생성 프롬프트가 정해지면 같은 인터페이스로 Claude 호출 구현으로 교체
 */

export interface PipelineInput {
  context: JobContext;
  commits: CommitDetail[];
}

export interface Pipeline {
  // 1단계: 커밋을 주제/작업 단위로 구분
  classify: (input: PipelineInput) => Promise<unknown>;
  // 2단계: 구분 결과를 바탕으로 변경 내용 분석
  analyze: (input: PipelineInput, classified: unknown) => Promise<unknown>;
  // 3단계: 분석 결과로 글 초안(Markdown) 작성
  write: (input: PipelineInput, analyzed: unknown) => Promise<string>;
}

// 변경 파일 목록 최대 표시 개수
const MAX_LISTED_FILES = 10;

const getSubject = (message: string) => message.split('\n')[0]?.trim() ?? '';

// 커밋 제목이 Markdown 문법으로 해석되지 않도록 특수 문자 이스케이프
const escapeMarkdown = (text: string) => {
  return text.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, '\\$1');
};

// [임시] LLM 없이 커밋 정보로 결과 뼈대를 만드는 단계 (인프라 연결 확인용)
export const createPlaceholderPipeline = (): Pipeline => ({
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
});
