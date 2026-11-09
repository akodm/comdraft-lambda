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
// 분석 단계에 보내는 hunk 합계 토큰 상한
export const HUNK_TOKEN_BUDGET = 40_000;
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
export const LINK_PREVIEW_CHARS = 300;
