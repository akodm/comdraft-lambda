// 비밀값 패턴 (AWS, GitHub, Slack, sk- 키, 개인 키, JWT, 키=값 할당)
const SECRET_PATTERNS: RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /gh[pos]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abpr]-[A-Za-z0-9-]+/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  /(password|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
];

export const containsSecret = (text: string): boolean =>
  SECRET_PATTERNS.some((pattern) => pattern.test(text));

// 이름만 남기고 본문은 넘기지 않는 파일 (.env*, *.pem, *.key, id_rsa*)
export const isSecretFile = (filename: string): boolean => {
  const base = filename.split('/').pop() ?? filename;
  return (
    base.startsWith('.env') ||
    base.endsWith('.pem') ||
    base.endsWith('.key') ||
    base.startsWith('id_rsa')
  );
};
