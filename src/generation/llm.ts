import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';

import { GenerationFailure } from '../errors.ts';

export const GENERATION_MODEL = 'claude-haiku-5-5';
// 요청 하나의 제한 시간 (Lambda 전체 제한보다 짧게)
export const LLM_TIMEOUT_MS = 75_000;

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

// 거절·토큰 초과는 결과를 믿을 수 없으므로 실패로 본다
const assertCompleted = (stopReason: string | null) => {
  if (stopReason === 'refusal' || stopReason === 'max_tokens') {
    throw fail();
  }
};

// SDK 오류 원문(요청·응답 내용이 섞일 수 있음)은 버리고 사유 코드만 남김
const guard = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch {
    throw fail();
  }
};

export const createAnthropicLlm = (client: Anthropic): LlmClient => ({
  parse: ({ system, user, schema, effort, maxTokens }) =>
    guard(async () => {
      const message = await client.messages.parse(
        {
          model: GENERATION_MODEL,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { effort, format: zodOutputFormat(schema) },
        },
        { timeout: LLM_TIMEOUT_MS },
      );

      assertCompleted(message.stop_reason);
      if (message.parsed_output == null) {
        throw fail();
      }
      return message.parsed_output;
    }),

  write: ({ system, user, effort, maxTokens }) =>
    guard(async () => {
      const message = await client.messages
        .stream(
          {
            model: GENERATION_MODEL,
            max_tokens: maxTokens,
            system,
            messages: [{ role: 'user', content: user }],
            output_config: { effort },
          },
          { timeout: LLM_TIMEOUT_MS },
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
