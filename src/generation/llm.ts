import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { GENERATION_MODEL_IDS, type GenerationModel } from '../contract.ts';
import { GenerationFailure } from '../errors.ts';
import { usageCost, type StageCall, type UsageTokens } from './models.ts';

// 요청 하나의 모델별 제한 시간 (Lambda 전체 제한 720초보다 짧게, 사고 깊이 medium·high 에서 출력 32,000토큰을 받을 수 있게)
export const LLM_TIMEOUT_MS_BY_MODEL: Record<GenerationModel, number> = {
  haiku: 180_000,
  sonnet: 240_000,
  opus: 300_000,
};
// 호출이 끝난 뒤 결과 저장이나 실패 기록에 남겨 두는 실행 시간
export const SAFETY_MARGIN_MS = 15_000;
// 이보다 짧은 제한 시간으로는 호출하지 않는다 (응답을 받기 어려워 시간 초과로 끝냄)
export const MIN_CALL_MS = 5_000;
// 재시도 전 잠시 기다리는 시간 (과부하·요청 한도 오류가 바로 다시 나지 않게)
export const RETRY_DELAY_MS = 1_000;

export interface LlmOptions {
  // Lambda 남은 실행 시간 (context.getRemainingTimeInMillis)
  remainingTimeMs: () => number;
  // 재시도 전 대기 (테스트에서 바꿔 끼움)
  sleep?: (ms: number) => Promise<void>;
}

// 사고 깊이 (adaptive thinking 은 기본 켜짐이라 thinking 은 보내지 않고 effort 로만 조절)
export type Effort = 'low' | 'medium' | 'high';

// 응답 하나의 사용량: 토큰 합과 그 모델 단가로 계산한 비용(마이크로달러)
export interface UsageReport {
  tokens: number;
  cost: number;
}

// 응답 하나를 받을 때마다 그 응답의 사용량을 넘김 (할당량 기록용)
export type OnUsage = (usage: UsageReport) => void | Promise<void>;

export interface LlmClient {
  parse: <T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    call: StageCall;
    maxTokens: number;
    onUsage?: OnUsage;
  }) => Promise<T>;
  write: (req: {
    system: string;
    user: string;
    call: StageCall;
    maxTokens: number;
    onUsage?: OnUsage;
  }) => Promise<string>;
}

// 사용량 = 입력 + 출력 + 캐시 생성 + 캐시 읽기 (없는 항목은 0)
export const sumUsage = (usage: Anthropic.Usage): number =>
  usage.input_tokens +
  usage.output_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0);

const toUsageTokens = (usage: Anthropic.Usage): UsageTokens => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheWrite: usage.cache_creation_input_tokens ?? 0,
  cacheRead: usage.cache_read_input_tokens ?? 0,
});

const fail = () => new GenerationFailure('llm_failed');
const timeout = () => new GenerationFailure('timeout');

// 이번 호출에 쓸 수 있는 시간: 호출 하나의 제한과 (남은 시간 - 여유분) 중 짧은 쪽
const callBudget = (model: GenerationModel, remainingMs: number): number =>
  Math.min(LLM_TIMEOUT_MS_BY_MODEL[model], remainingMs - SAFETY_MARGIN_MS);

// 연결 오류와 408·409·429·5xx 만 다시 시도한다 (SDK 기본 재시도 기준과 같음)
const isRetryable = (error: unknown): boolean => {
  if (error instanceof APIConnectionError) return true;
  if (!(error instanceof APIError) || typeof error.status !== 'number') return false;
  return [408, 409, 429].includes(error.status) || error.status >= 500;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RequestOptions {
  timeout: number;
  maxRetries: number;
  signal: AbortSignal;
}

// 거절·토큰 초과는 결과를 믿을 수 없으므로 실패로 본다
const assertCompleted = (stopReason: string | null) => {
  if (stopReason === 'refusal' || stopReason === 'max_tokens') {
    throw fail();
  }
};

/**
 * 남은 실행 시간 안에서만 호출한다
 * - SDK 제한 시간은 응답 머리까지만 걸리므로, 같은 기한의 중단 신호로 스트림 끝까지 묶는다
 * - SDK 자동 재시도는 끄고, 재시도할 수 있는 오류에 한해 새 시도를 온전히 할 시간이 있을 때만 한 번 더 한다
 * - 남은 시간 때문에 끊긴 호출은 timeout, 나머지 실패는 llm_failed
 * - SDK 오류 원문(요청·응답 내용이 섞일 수 있음)은 버리고 사유 코드만 남김
 * - 받은 응답의 검사(거절, 토큰 초과 등)는 사용량을 보고한 뒤 호출한 쪽에서 한다
 */
const callWithDeadline = async <T>(
  { remainingTimeMs, sleep = defaultSleep }: LlmOptions,
  model: GenerationModel,
  run: (options: RequestOptions) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const budget = callBudget(model, remainingTimeMs());
    if (budget <= MIN_CALL_MS) {
      throw timeout();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    try {
      return await run({ timeout: budget, maxRetries: 0, signal: controller.signal });
    } catch (error) {
      const shortened = budget < LLM_TIMEOUT_MS_BY_MODEL[model];
      if (
        controller.signal.aborted ||
        (shortened && error instanceof APIConnectionTimeoutError)
      ) {
        // 남은 시간 때문에 줄인 기한에 걸렸으면 시간 초과, 원래 제한 시간에 걸렸으면 일시 오류로 본다
        if (shortened) throw timeout();
      } else if (!isRetryable(error)) {
        throw fail();
      }

      const canRetry =
        attempt === 0 &&
        callBudget(model, remainingTimeMs() - RETRY_DELAY_MS) >=
          LLM_TIMEOUT_MS_BY_MODEL[model];
      if (!canRetry) {
        throw fail();
      }
    } finally {
      clearTimeout(timer);
    }

    await sleep(RETRY_DELAY_MS);
  }
};

/**
 * 응답을 받은 뒤 사용량부터 보고한다
 * - 재시도 판단(callWithDeadline) 밖에서 부르므로, 기록 실패가 llm_failed 로 바뀌거나 호출을 다시 하게 만들지 않는다
 * - 거절·토큰 초과 응답도 토큰은 쓴 것이라 검사보다 먼저 보고한다
 * - 비용은 그 응답을 만든 모델의 단가로 계산한다
 */
const reportUsage = async (
  model: GenerationModel,
  message: { usage: Anthropic.Usage },
  onUsage?: OnUsage,
) => {
  if (onUsage) {
    await onUsage({
      tokens: sumUsage(message.usage),
      cost: usageCost(model, toUsageTokens(message.usage)),
    });
  }
};

/**
 * 고른 모델로 한 번 부르고, 거절(refusal)이면 fallback(haiku)으로 한 번 더 부른다
 * - 두 호출 모두 사용량을 각자 모델 단가로 보고한다
 * - fallback 이 없거나 fallback 도 거절하면 돌려주는 응답의 stop_reason 이 refusal 이라 호출한 쪽의 검사가 llm_failed 로 만든다
 */
const callWithFallback = async (
  options: LlmOptions,
  call: StageCall,
  request: (
    model: GenerationModel,
    effort: Effort,
  ) => (requestOptions: RequestOptions) => Promise<Anthropic.Message>,
  onUsage?: OnUsage,
): Promise<Anthropic.Message> => {
  const first = await callWithDeadline(options, call.model, request(call.model, call.effort));
  await reportUsage(call.model, first, onUsage);
  if (first.stop_reason !== 'refusal' || !call.fallback) {
    return first;
  }

  const { model, effort } = call.fallback;
  const second = await callWithDeadline(options, model, request(model, effort));
  await reportUsage(model, second, onUsage);
  return second;
};

export const createAnthropicLlm = (
  client: Anthropic,
  options: LlmOptions,
): LlmClient => ({
  // SDK 의 messages.parse 는 응답을 구조화 출력으로 바꾸다 실패하면 응답 없이 던지므로,
  // 스트림의 최종 응답을 받아 사용량을 먼저 보고한 뒤 직접 파싱한다
  // (사고 깊이를 올리면 응답이 길어져 한 번에 받는 요청보다 스트림이 끊기지 않는다)
  parse: async ({ system, user, schema, call, maxTokens, onUsage }) => {
    const format = zodOutputFormat(schema);
    const message = await callWithFallback(
      options,
      call,
      (model, effort) => (requestOptions) =>
        client.messages
          .stream(
            {
              model: GENERATION_MODEL_IDS[model],
              max_tokens: maxTokens,
              system,
              messages: [{ role: 'user', content: user }],
              output_config: { effort, format },
            },
            requestOptions,
          )
          .finalMessage(),
      onUsage,
    );

    assertCompleted(message.stop_reason);
    // SDK 와 같이 첫 text 블록을 결과로 본다 (thinking 블록은 건너뜀)
    const text = message.content.find((block) => block.type === 'text')?.text;
    if (text == null) {
      throw fail();
    }
    // JSON·스키마 오류 원문에는 응답 내용이 섞일 수 있어 사유 코드만 남김
    try {
      return format.parse(text);
    } catch {
      throw fail();
    }
  },

  write: async ({ system, user, call, maxTokens, onUsage }) => {
    const message = await callWithFallback(
      options,
      call,
      (model, effort) => (requestOptions) =>
        client.messages
          .stream(
            {
              model: GENERATION_MODEL_IDS[model],
              max_tokens: maxTokens,
              system,
              messages: [{ role: 'user', content: user }],
              output_config: { effort },
            },
            requestOptions,
          )
          .finalMessage(),
      onUsage,
    );

    assertCompleted(message.stop_reason);
    // thinking 블록이 앞에 올 수 있어 text 블록만 이어 붙임
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    if (text.trim() === '') {
      throw fail();
    }
    return text;
  },
});
