// 키=값 할당 (복합 이름 허용: SECRET_KEY, client_secret_value, "apiKey": ...)
// - 따옴표(" ' `)로 감싼 값은 8자 이상이면 모두 비밀로 본다.
// - 따옴표 없는 값(.env, YAML)은 8자 이상이고 숫자를 하나 이상 포함하며, 뒤에 `(` `.` 등이
//   이어지지 않아야 한다. 그래서 `getToken()`, `process.env.API_KEY`, `password: string;` 같은
//   코드·타입 표기는 걸리지 않는다. (`.` 가 든 평문 비밀번호는 놓칠 수 있다.)
const KEY_VALUE_PATTERN =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*(?:"[^"]{8,}"|'[^']{8,}'|`[^`]{8,}`|(?=[A-Za-z0-9_\-+/=@!#$%^&*~]*\d)[A-Za-z0-9_\-+/=@!#$%^&*~]{8,}(?=[\s,;}\])]|$))/i;

// 비밀값 패턴 (스펙 4절 목록 + 흔한 형태 확장)
const SECRET_PATTERNS: RegExp[] = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abpr]-[A-Za-z0-9-]+/,
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/,
  /[sr]k_live_[A-Za-z0-9]{16,}/,
  /AIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // 자격 증명이 든 접속 문자열 (postgres://user:pass@host, 사용자 없는 redis://:pass@host)
  /[a-z][a-z0-9+]*:\/\/[^\s:/@]*:[^\s@/]+@/i,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  KEY_VALUE_PATTERN,
];

export const containsSecret = (text: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(text));

const GLOBAL_PATTERNS = SECRET_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags}g`),
);

// 비밀값으로 보이는 부분만 `[가림]` 으로 바꾼다
export const redactSecrets = (text: string): string =>
  GLOBAL_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[가림]'), text);

// 이름만 남기고 본문은 넘기지 않는 파일 (.env*, *.pem, *.key, SSH 키 id_rsa*·id_ed25519*·id_ecdsa*·id_dsa*)
const SSH_KEY_PREFIXES = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'];

export const isSecretFile = (filename: string): boolean => {
  const base = (filename.split('/').pop() ?? filename).toLowerCase();
  return (
    base.startsWith('.env') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    SSH_KEY_PREFIXES.some((prefix) => base.startsWith(prefix))
  );
};
