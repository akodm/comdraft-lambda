import type { GenerationClarification } from '../contract.ts';
import type { ClarifyRequest, RawPlan } from './schemas.ts';

// 되묻기 한도. 질문·보기 수와 문장 길이는 모델이 어겨도 여기서 맞춘다 (comdraft 화면이 이 한도를 전제로 한다)
export const CLARIFY_MAX_QUESTIONS = 3;
export const CLARIFY_MAX_OPTIONS = 3;
// 보기가 이보다 적으면 보기를 비우고 직접 입력만 받는다
export const CLARIFY_MIN_OPTIONS = 2;
export const CLARIFY_REASON_MAX = 200;
export const CLARIFY_QUESTION_MAX = 200;
export const CLARIFY_OPTION_MAX = 120;

// 앞뒤 공백을 빼고 상한 글자 수까지만 남긴다
const clip = (text: string, max: number): string =>
  Array.from(text.trim()).slice(0, max).join('').trim();

// 비어 있지 않은 문장만 앞에서 limit 개까지, 상한 글자 수로 자른다
const keepSentences = (texts: string[], limit: number, max: number): string[] =>
  texts
    .map((text) => clip(text, max))
    .filter((text) => text.length > 0)
    .slice(0, limit);

// 기획이 낸 되묻기 판단을 보정한다. 물을 게 남지 않으면 null (묻지 않고 작성한다)
export const validateClarify = (raw: RawPlan['clarify']): ClarifyRequest | null => {
  if (!raw.needed) return null;

  const questions = raw.questions
    .map((item) => ({
      question: clip(item.question, CLARIFY_QUESTION_MAX),
      options: keepSentences(item.options, CLARIFY_MAX_OPTIONS, CLARIFY_OPTION_MAX),
    }))
    .filter((item) => item.question.length > 0)
    .slice(0, CLARIFY_MAX_QUESTIONS)
    .map((item, index) => ({
      id: `Q${index + 1}`,
      question: item.question,
      options: item.options.length < CLARIFY_MIN_OPTIONS ? [] : item.options,
    }));

  if (questions.length === 0) return null;
  return { reason: clip(raw.reason, CLARIFY_REASON_MAX), questions };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isQuestion = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.question === 'string' &&
  isStringArray(value.options);

const isAnswer = (value: unknown): boolean =>
  isRecord(value) && typeof value.id === 'string' && typeof value.answer === 'string';

const isAnswers = (value: unknown): boolean =>
  value === null || value === 'skipped' || (Array.isArray(value) && value.every(isAnswer));

// DB 의 draft_prompt.clarification (jsonb). 문자열로 오면 JSON 으로 읽고, 형식이 다르면 null
export const parseJobClarification = (value: unknown): GenerationClarification | null => {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.reason !== 'string' ||
    !Array.isArray(parsed.questions) ||
    !parsed.questions.every(isQuestion) ||
    !isAnswers(parsed.answers)
  ) {
    return null;
  }

  return parsed as unknown as GenerationClarification;
};

// 작성자가 답한 질문과 답을 질문 순서대로 짝짓는다. 답이 배열이 아니면(대기·그냥 작성) 빈 목록
export const answeredPairs = (
  clarification: GenerationClarification | null,
): { id: string; question: string; answer: string }[] => {
  const answers = clarification?.answers;
  if (!clarification || !Array.isArray(answers)) return [];

  return clarification.questions.flatMap((question) => {
    const found = answers.find((answer) => answer.id === question.id);
    return found ? [{ id: question.id, question: question.question, answer: found.answer }] : [];
  });
};
