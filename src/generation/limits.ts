import type { Length } from '../prompts/types.ts';

// 커밋 메시지 한 개에서 넣는 최대 글자 수
export const MAX_MESSAGE_CHARS = 1_000;
// 기획 단계에 보내는 커밋 카탈로그 토큰 상한 (넘으면 최근 커밋부터 hunk 줄을 줄인다)
export const PLAN_CATALOG_TOKENS = 20_000;
// 커밋 하나의 카탈로그에 올리는 최대 파일 수
export const MAX_CATALOG_FILES_PER_COMMIT = 50;
// 분석 단계에 보내는 hunk 개수 상한
export const MAX_SELECTED_HUNKS = 30;
// hunk 하나에서 보여 주는 최대 줄 수
export const MAX_HUNK_LINES = 150;
// 이보다 긴 줄이 있는 hunk(minified, 생성된 데이터 등)는 본문을 넘기지 않음
export const MAX_HUNK_LINE_CHARS = 1_000;
// 비밀값 가림 전에 커밋 메시지를 자를 때 남기는 여유 (경계에 걸친 토큰도 잡기 위해)
export const MESSAGE_REDACT_MARGIN = 512;
// 분석 단계에 보내는 hunk 합계 토큰 상한
export const HUNK_TOKEN_BUDGET = 40_000;
// 할당량 예상량에 넣는 단계별 출력 여유분
export const ESTIMATE_PLAN_OUTPUT = 3_000;
export const ESTIMATE_ANALYSIS_OUTPUT = 6_000;
export const ESTIMATE_WRITE_OUTPUT: Readonly<Record<Length, number>> = {
  short: 6_000,
  medium: 9_000,
  long: 14_000,
};
// 빈칸 채우기 예상량에 넣는 출력 여유분
export const ESTIMATE_FILL_OUTPUT = 1_500;
// 빈칸 채우기 결과로 남기는 최대 문단 수 (comdraft MAX_FILL_PARAGRAPHS 와 같은 값)
export const MAX_FILL_PARAGRAPHS = 3;
// 초안에 삽입하는 코드 블록 최대 줄 수
export const MAX_CODE_LINES = 40;

// 토큰 수 추정: ASCII 3자당 1, 비ASCII 1자당 1 (새 토크나이저 기준으로 보수적)
export const estimateTokens = (text: string): number => {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
};

// 근거로 쓰는 참고 링크 최대 개수 (L1~L10)
export const MAX_REFERENCE_LINKS = 10;
// 링크 하나를 가져오는 제한 시간
export const LINK_TIMEOUT_MS = 5_000;
// 링크 응답에서 읽는 최대 바이트
export const LINK_MAX_BYTES = 1_048_576;
// 따라가는 리다이렉트 최대 횟수
export const LINK_MAX_REDIRECTS = 3;
// 링크 하나의 본문 토큰 상한
export const LINK_TOKEN_BUDGET = 3_000;
// 링크 제목 최대 글자 수
export const LINK_TITLE_MAX = 80;
// 링크 본문 미리보기 글자 수
export const LINK_PREVIEW_CHARS = 1_500;

// 검토 결과로 남기는 최대 항목 수와 항목별 고칠 방법 최대 글자 수
export const MAX_REVIEW_ISSUES = 8;
export const REVIEW_FIX_MAX = 150;
// 검토 프롬프트가 안내하는 quote 최대 글자 수 (검증은 초안에 있는지만 본다)
export const REVIEW_QUOTE_MAX = 200;
// 남은 시간이 이보다 적으면 검토·고쳐 쓰기를 건너뛴다 (LLM 제한 시간 75초 + 안전 여유 15초)
export const REVIEW_MIN_REMAINING_MS = 60_000;
export const REVISE_MIN_REMAINING_MS = 90_000;
