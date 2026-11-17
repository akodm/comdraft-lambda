import type { CodeInputMeta, GenerationCodeInput } from '../contract.ts';

/**
 * 직접 입력 코드 검증 (comdraft lib/generation/code-input.ts 와 같은 규칙)
 * - 코드는 요청 본문으로만 받고 메모리에서만 쓴다 (저장하거나 로그에 남기지 않음)
 * - DB 에는 이름과 줄 수(CodeInputMeta)만 있어, 받은 코드가 그 작업의 코드인지 이 값으로 맞춰 본다
 */
export const CODE_INPUT_LIMITS = {
  maxInputs: 5,
  maxLines: 300,
  maxChars: 20_000,
  maxTotalChars: 50_000,
  maxNameChars: 100,
} as const;

// 이름에 넣을 수 없는 줄바꿈·제어 문자
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// 줄바꿈을 LF 로 맞춘다 (화면·서버·Lambda 가 같은 줄 수를 세도록)
export const normalizeCode = (code: string): string => code.replace(/\r\n?/g, '\n');

// 끝 줄바꿈 하나를 뺀 줄 수
export const countLines = (code: string): number =>
  normalizeCode(code).replace(/\n$/, '').split('\n').length;

const isValidName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= CODE_INPUT_LIMITS.maxNameChars &&
  !CONTROL_CHARS.test(name);

// 요청 값 → 직접 입력 코드 목록 (생략은 빈 목록, 형식이 다르거나 제한을 넘으면 null)
export const parseCodeInputs = (value: unknown): GenerationCodeInput[] | null => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > CODE_INPUT_LIMITS.maxInputs) return null;

  const inputs: GenerationCodeInput[] = [];
  let total = 0;

  for (const item of value) {
    if (typeof item !== 'object' || item === null) return null;
    const { name, code } = item as Record<string, unknown>;
    if (!isValidName(name) || typeof code !== 'string') return null;

    const normalized = normalizeCode(code);
    if (
      !normalized.trim() ||
      normalized.length > CODE_INPUT_LIMITS.maxChars ||
      countLines(normalized) > CODE_INPUT_LIMITS.maxLines
    ) {
      return null;
    }

    total += normalized.length;
    inputs.push({ name, code: normalized });
  }

  return total > CODE_INPUT_LIMITS.maxTotalChars ? null : inputs;
};

// 받은 코드가 작업에 저장된 이름·줄 수와 순서까지 같은지
export const matchesCodeInputMeta = (
  inputs: GenerationCodeInput[],
  meta: CodeInputMeta[],
): boolean =>
  inputs.length === meta.length &&
  inputs.every(
    (input, index) =>
      input.name === meta[index].name && countLines(input.code) === meta[index].lines,
  );
