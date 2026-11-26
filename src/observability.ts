import * as Sentry from '@sentry/node';
import type { Breadcrumb, ErrorEvent } from '@sentry/node';
import type { ReportContext } from './run-job.ts';

/**
 * Sentry 오류 보고 (CloudWatch Logs 를 쓰지 않으므로 실패 원인은 여기로만 남김)
 * - SENTRY_DSN 이 없으면 꺼짐 (로컬 실행, 테스트)
 * - 오류만 보냄: 성능 추적·로그 전송은 쓰지 않음
 * - SDK 가 스스로 모으는 데이터는 모두 끔 (특히 지역 변수: 커밋 코드, 직접 입력 코드, 토큰이 들어 있음)
 * - 보내기 전 메시지의 토큰 형태를 가리고 길이를 제한, 주소 기록은 쿼리를 지움
 * - 태그에는 작업 id, 단계, 사유 코드 같은 식별자만 (저장소 이름·요청 문구·코드·응답은 넣지 않음)
 */

const MAX_MESSAGE_LENGTH = 500;
const REDACTED = '[redacted]';

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s@]+@/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

export const scrubMessage = (message: string): string => {
  const masked = SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED),
    message,
  );

  return masked.length > MAX_MESSAGE_LENGTH
    ? `${masked.slice(0, MAX_MESSAGE_LENGTH)}…`
    : masked;
};

const stripQuery = (url: string): string => url.replace(/[?#].*$/, '');

export const scrubBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  // 콘솔 기록은 보내지 않음
  if (breadcrumb.category === 'console') return null;

  const data = breadcrumb.data ? { ...breadcrumb.data } : undefined;
  if (data && typeof data.url === 'string') data.url = stripQuery(data.url);

  return {
    ...breadcrumb,
    ...(breadcrumb.message ? { message: scrubMessage(breadcrumb.message) } : {}),
    ...(data ? { data } : {}),
  };
};

export const scrubEvent = (event: ErrorEvent): ErrorEvent => {
  delete event.request;
  delete event.user;
  delete event.extra;

  if (event.message) event.message = scrubMessage(event.message);

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubMessage(exception.value);
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .map(scrubBreadcrumb)
      .filter((breadcrumb): breadcrumb is Breadcrumb => breadcrumb !== null);
  }

  return event;
};

let initialized = false;

// 콜드 스타트에 한 번만 초기화 (DSN 이 없으면 아무것도 보내지 않음)
export const initObservability = (env: NodeJS.ProcessEnv = process.env): void => {
  if (initialized) return;
  initialized = true;

  const dsn = env.SENTRY_DSN;

  Sentry.init({
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT || 'production',
    release: env.SENTRY_RELEASE || undefined,
    // 서버 이름(실행 환경 호스트)은 의미가 없어 보내지 않음
    includeServerName: false,
    maxBreadcrumbs: 30,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  });
};

/**
 * 작업 하나의 보고 함수 (작업 id 와 단계 등 식별자를 태그로)
 * - 같은 단계·사유는 한 이슈로 묶이도록 fingerprint 에 단계와 사유 코드를 넣음
 */
export const createReporter =
  (base: ReportContext) =>
  (error: unknown, context: ReportContext = {}): void => {
    const tags = { ...base, ...context };

    Sentry.withScope((scope) => {
      for (const [key, value] of Object.entries(tags)) {
        if (value !== undefined) scope.setTag(key, String(value));
      }

      if (typeof tags.stage === 'string' && typeof tags.errorCode === 'string') {
        scope.setFingerprint(['generation', tags.stage, tags.errorCode, String(tags.reason ?? '')]);
      }

      Sentry.captureException(error);
    });
  };

// Lambda 가 응답 뒤 얼어붙기 전에 보낸 오류를 전송 (실패해도 작업 결과에는 영향 없음)
export const flushObservability = async (timeoutMs = 2000): Promise<void> => {
  await Sentry.flush(timeoutMs).catch(() => false);
};
