import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { GenerationFailure } from '../errors.ts';

export const GENERATION_MODEL = 'claude-haiku-5-5';
// 요청 하나의 제한 시간 (Lambda 전체 제한보다 짧게)
export const LLM_TIMEOUT_MS = 75_000;
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
export type Effort = 'low' | 'medium';

export interface LlmClient {
  parse: <T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    effort: Effort;
    maxTokens: number;
  }) => Promise<T>;
  write: (req: {
    system: string;
    user: string;
    effort: Effort;
    maxTokens: number;
  }) => Promise<string>;
}

const fail = () => new GenerationFailure('llm_failed');
const timeout = () => new GenerationFailure('timeout');

// 이번 호출에 쓸 수 있는 시간: 호출 하나의 제한과 (남은 시간 - 여유분) 중 짧은 쪽
const callBudget = (remainingMs: number): number =>
  Math.min(LLM_TIMEOUT_MS, remainingMs - SAFETY_MARGIN_MS);

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
 */
const callWithDeadline = async <T>(
  { remainingTimeMs, sleep = defaultSleep }: LlmOptions,
  run: (options: RequestOptions) => Promise<T>,
): Promise<T> => {
  for (let attempt = 0; ; attempt += 1) {
    const budget = callBudget(remainingTimeMs());
    if (budget <= MIN_CALL_MS) {
      throw timeout();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    try {
      return await run({ timeout: budget, maxRetries: 0, signal: controller.signal });
    } catch (error) {
      // 응답을 받았지만 쓸 수 없는 경우 (거절, 토큰 초과 등)
      if (error instanceof GenerationFailure) {
        throw error;
      }

      const shortened = budget < LLM_TIMEOUT_MS;
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
        callBudget(remainingTimeMs() - RETRY_DELAY_MS) >= LLM_TIMEOUT_MS;
      if (!canRetry) {
        throw fail();
      }
    } finally {
      clearTimeout(timer);
    }

    await sleep(RETRY_DELAY_MS);
  }
};

export const createAnthropicLlm = (
  client: Anthropic,
  options: LlmOptions,
): LlmClient => ({
  parse: ({ system, user, schema, effort, maxTokens }) =>
    callWithDeadline(options, async (requestOptions) => {
      const message = await client.messages.parse(
        {
          model: GENERATION_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { effort, format: zodOutputFormat(schema) },
        },
        requestOptions,
      );

      assertCompleted(message.stop_reason);
      if (message.parsed_output == null) {
        throw fail();
      }
      return message.parsed_output;
    }),

  write: ({ system, user, effort, maxTokens }) =>
    callWithDeadline(options, async (requestOptions) => {
      const message = await client.messages
        .stream(
          {
            model: GENERATION_MODEL,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
            output_config: { effort },
          },
          requestOptions,
        )
        .finalMessage();

      assertCompleted(message.stop_reason);
      // thinking 블록이 앞에 올 수 있어 text 블록만 이어 붙임
      const text = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      if (text.trim() === '') {
        throw fail();
      }
      return text;
    }),
});
