import type Anthropic from '@anthropic-ai/sdk';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { GenerationFailure } from '../errors.ts';
import {
  createAnthropicLlm as createLlm,
  GENERATION_MODEL,
  LLM_TIMEOUT_MS,
  MIN_CALL_MS,
  SAFETY_MARGIN_MS,
  type LlmOptions,
} from './llm.ts';

type Req = Record<string, any>;

// 시간이 넉넉한 기본 옵션 (재시도 대기는 기다리지 않는다)
const PLENTY_MS = 10 * 60_000;
const createAnthropicLlm = (client: Anthropic, options: Partial<LlmOptions> = {}) =>
  createLlm(client, { remainingTimeMs: () => PLENTY_MS, sleep: async () => {}, ...options });

// 가짜 SDK 클라이언트: 받은 요청과 옵션을 기록하고 정해 둔 응답(또는 오류)을 돌려준다
const fakeClient = (reply: () => unknown) => {
  const calls: { method: 'create' | 'stream'; req: Req; options: Req }[] = [];
  const client = {
    messages: {
      // 구조화 출력도 스트림의 최종 응답(text 블록)을 받아 직접 파싱하므로, 가짜도 원본 응답을 돌려준다
      create: async (req: Req, options: Req) => {
        calls.push({ method: 'create', req, options });
        return reply();
      },
      stream: (req: Req, options: Req) => {
        calls.push({ method: 'stream', req, options });
        return { finalMessage: async () => reply() };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
};

const schema = z.object({ answer: z.string() });
// 구조화 출력 응답 (모델이 돌려주는 원문 그대로)
const jsonReply = (text: string, stop_reason = 'end_turn') => ({
  stop_reason,
  content: [
    { type: 'thinking', thinking: 'hmm', signature: 's' },
    { type: 'text', text },
  ],
});
const parseReq = { system: 'sys', user: 'usr', schema, effort: 'low' as const, maxTokens: 8000 };
const writeReq = { system: 'sys', user: 'usr', effort: 'medium' as const, maxTokens: 6000 };

const rejectsLlmFailed = async (promise: Promise<unknown>) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof GenerationFailure);
    assert.equal(error.code, 'llm_failed');
    assert.equal(error.message, 'llm_failed');
    return true;
  });

describe('createAnthropicLlm.parse', () => {
  it('model·effort·max_tokens·format 을 스트림으로 보내고 sampling·thinking 은 보내지 않는다', async () => {
    const { client, calls } = fakeClient(() => jsonReply('{"answer":"ok"}'));

    const result = await createAnthropicLlm(client).parse(parseReq);

    assert.deepEqual(result, { answer: 'ok' });
    const { method, req, options } = calls[0];
    // 사고 깊이를 올리면 응답이 길어져 한 번에 받는 요청은 끊기기 쉬워 구조화 출력도 스트림으로 받는다
    assert.equal(method, 'stream');
    assert.equal(req.model, GENERATION_MODEL);
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.equal(req.max_tokens, 8000);
    assert.equal(req.system, 'sys');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'usr' }]);
    assert.equal(req.output_config.effort, 'low');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.equal('temperature' in req, false);
    assert.equal('top_p' in req, false);
    assert.equal('top_k' in req, false);
    assert.equal('thinking' in req, false);
    assert.equal(options.timeout, LLM_TIMEOUT_MS);
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
  });

  for (const stop_reason of ['refusal', 'max_tokens']) {
    it(`stop_reason ${stop_reason} 는 llm_failed`, async () => {
      const { client } = fakeClient(() => jsonReply('{"answer":"x"}', stop_reason));
      await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
    });
  }

  it('text 블록이 없으면 llm_failed', async () => {
    const { client } = fakeClient(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'x', signature: 's' }],
    }));
    await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
  });

  it('JSON 이 아니거나 스키마에 맞지 않으면 llm_failed 이고 원문을 남기지 않는다', async () => {
    for (const text of ['secret-token 일반 문장', '{"answer":1}']) {
      const { client } = fakeClient(() => jsonReply(text));
      await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
    }
  });

  it('SDK 가 던진 오류는 llm_failed 로 바꾸고 원문 메시지를 남기지 않는다', async () => {
    const { client } = fakeClient(() => {
      throw new Error('secret-token usr text');
    });
    await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
  });
});

describe('createAnthropicLlm.write', () => {
  it('text 블록만 이어 붙인다 (thinking 블록 무시)', async () => {
    const { client, calls } = fakeClient(() => ({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: '앞' },
        { type: 'text', text: '뒤' },
      ],
    }));

    const result = await createAnthropicLlm(client).write(writeReq);

    assert.equal(result, '앞뒤');
    const { method, req, options } = calls[0];
    assert.equal(method, 'stream');
    assert.equal(req.model, 'claude-haiku-5-5');
    assert.equal(req.max_tokens, 6000);
    assert.equal(req.output_config.effort, 'medium');
    assert.equal('format' in req.output_config, false);
    assert.equal('temperature' in req, false);
    assert.equal('thinking' in req, false);
    assert.equal(options.timeout, LLM_TIMEOUT_MS);
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
  });

  for (const stop_reason of ['refusal', 'max_tokens']) {
    it(`stop_reason ${stop_reason} 는 llm_failed`, async () => {
      const { client } = fakeClient(() => ({
        stop_reason,
        content: [{ type: 'text', text: 'partial' }],
      }));
      await rejectsLlmFailed(createAnthropicLlm(client).write(writeReq));
    });
  }

  it('text 가 비어 있으면 llm_failed', async () => {
    const { client } = fakeClient(() => ({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: 'x', signature: 's' }],
    }));
    await rejectsLlmFailed(createAnthropicLlm(client).write(writeReq));
  });

  it('SDK 가 던진 오류는 llm_failed 로 바꾼다', async () => {
    const { client } = fakeClient(() => {
      throw new Error('boom');
    });
    await rejectsLlmFailed(createAnthropicLlm(client).write(writeReq));
  });
});

const okParse = () => jsonReply('{"answer":"ok"}');
const okWrite = () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '글' }] });

const rejectsTimeout = async (promise: Promise<unknown>) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof GenerationFailure);
    assert.equal(error.code, 'timeout');
    return true;
  });

// 차례대로 오류를 던지다가 다 쓰면 성공 응답을 돌려준다
const failThen = (errors: unknown[], success: () => unknown) => {
  let index = 0;
  return () => {
    if (index < errors.length) {
      index += 1;
      throw errors[index - 1];
    }
    return success();
  };
};

const overloaded = () => APIError.generate(529, undefined, 'overloaded', new Headers());

describe('createAnthropicLlm 시간 예산', () => {
  for (const [method, run, ok] of [
    ['parse', (llm: ReturnType<typeof createLlm>) => llm.parse(parseReq), okParse],
    ['write', (llm: ReturnType<typeof createLlm>) => llm.write(writeReq), okWrite],
  ] as const) {
    it(`${method}: 남은 시간이 최소 호출 시간보다 짧으면 호출하지 않고 timeout`, async () => {
      const { client, calls } = fakeClient(ok);
      const llm = createAnthropicLlm(client, {
        remainingTimeMs: () => SAFETY_MARGIN_MS + MIN_CALL_MS - 1,
      });
      await rejectsTimeout(run(llm));
      assert.equal(calls.length, 0);
    });

    it(`${method}: 남은 시간에서 여유분을 뺀 만큼만 제한 시간으로 보낸다`, async () => {
      const { client, calls } = fakeClient(ok);
      const llm = createAnthropicLlm(client, {
        remainingTimeMs: () => SAFETY_MARGIN_MS + 40_000,
      });
      await run(llm);
      assert.equal(calls[0].options.timeout, 40_000);
      assert.equal(calls[0].options.maxRetries, 0);
    });

    it(`${method}: 재시도할 수 있는 오류는 시간이 넉넉하면 한 번만 다시 시도한다`, async () => {
      const { client, calls } = fakeClient(failThen([overloaded()], ok));
      const slept: number[] = [];
      const llm = createAnthropicLlm(client, {
        sleep: async (ms) => {
          slept.push(ms);
        },
      });
      await run(llm);
      assert.equal(calls.length, 2);
      assert.equal(slept.length, 1);
    });

    it(`${method}: 두 번째도 실패하면 더 시도하지 않고 llm_failed`, async () => {
      const { client, calls } = fakeClient(
        failThen([overloaded(), new APIConnectionError({ message: 'reset' }), overloaded()], ok),
      );
      await rejectsLlmFailed(run(createAnthropicLlm(client)));
      assert.equal(calls.length, 2);
    });

    it(`${method}: 새 시도 한 번을 온전히 할 시간이 없으면 재시도하지 않는다`, async () => {
      const { client, calls } = fakeClient(failThen([overloaded()], ok));
      const llm = createAnthropicLlm(client, {
        remainingTimeMs: () => SAFETY_MARGIN_MS + LLM_TIMEOUT_MS - 1,
      });
      await rejectsLlmFailed(run(llm));
      assert.equal(calls.length, 1);
    });

    it(`${method}: 재시도할 수 없는 오류(400)는 바로 llm_failed`, async () => {
      const { client, calls } = fakeClient(
        failThen([APIError.generate(400, undefined, 'bad', new Headers())], ok),
      );
      await rejectsLlmFailed(run(createAnthropicLlm(client)));
      assert.equal(calls.length, 1);
    });

    it(`${method}: 남은 시간 때문에 줄인 제한 시간을 넘기면 timeout`, async () => {
      const { client, calls } = fakeClient(failThen([new APIConnectionTimeoutError()], ok));
      const llm = createAnthropicLlm(client, {
        remainingTimeMs: () => SAFETY_MARGIN_MS + 30_000,
      });
      await rejectsTimeout(run(llm));
      assert.equal(calls.length, 1);
    });

    it(`${method}: 기한이 되면 진행 중인 요청을 끊고 timeout`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      // 신호가 끊기면 SDK 처럼 APIUserAbortError 로 거절한다
      const waitForAbort = (options: Req) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new APIUserAbortError()));
        });
      const calls: Req[] = [];
      const client = {
        messages: {
          create: (_req: Req, options: Req) => {
            calls.push(options);
            return waitForAbort(options);
          },
          stream: (_req: Req, options: Req) => {
            calls.push(options);
            return { finalMessage: () => waitForAbort(options) };
          },
        },
      } as unknown as Anthropic;
      const llm = createAnthropicLlm(client, {
        remainingTimeMs: () => SAFETY_MARGIN_MS + 20_000,
      });

      const pending = run(llm);
      t.mock.timers.tick(19_999);
      assert.equal(calls[0].signal.aborted, false);
      t.mock.timers.tick(1);
      await rejectsTimeout(pending);
      assert.equal(calls.length, 1);
    });
  }
});

const USAGE = {
  input_tokens: 10,
  output_tokens: 20,
  cache_creation_input_tokens: 3,
  cache_read_input_tokens: 4,
};

describe('createAnthropicLlm 사용량 보고', () => {
  for (const [method, call, ok] of [
    [
      'parse',
      (llm: ReturnType<typeof createLlm>, onUsage: (tokens: number) => void) =>
        llm.parse({ ...parseReq, onUsage }),
      okParse,
    ],
    [
      'write',
      (llm: ReturnType<typeof createLlm>, onUsage: (tokens: number) => void) =>
        llm.write({ ...writeReq, onUsage }),
      okWrite,
    ],
  ] as const) {
    it(`${method}: 사용량은 네 항목 합`, async () => {
      const { client } = fakeClient(() => ({ ...ok(), usage: USAGE }));
      const reported: number[] = [];
      await call(createAnthropicLlm(client), (tokens) => {
        reported.push(tokens);
      });
      assert.deepEqual(reported, [37]);
    });

    it(`${method}: 캐시 항목이 없으면 0 으로 센다`, async () => {
      const { client } = fakeClient(() => ({
        ...ok(),
        usage: { ...USAGE, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      }));
      const reported: number[] = [];
      await call(createAnthropicLlm(client), (tokens) => {
        reported.push(tokens);
      });
      assert.deepEqual(reported, [30]);
    });

    it(`${method}: 재시도하면 실제로 받은 응답만 센다`, async () => {
      const { client, calls } = fakeClient(
        failThen([overloaded()], () => ({ ...ok(), usage: USAGE })),
      );
      const reported: number[] = [];
      await call(createAnthropicLlm(client), (tokens) => {
        reported.push(tokens);
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(reported, [37]);
    });

    it(`${method}: 거절 응답도 사용량은 남긴다`, async () => {
      const { client } = fakeClient(() => ({ ...ok(), stop_reason: 'refusal', usage: USAGE }));
      const reported: number[] = [];
      await rejectsLlmFailed(
        call(createAnthropicLlm(client), (tokens) => {
          reported.push(tokens);
        }),
      );
      assert.deepEqual(reported, [37]);
    });

    it(`${method}: 사용량 기록이 실패하면 llm_failed 로 바꾸지 않고 그대로 전달한다`, async () => {
      const { client, calls } = fakeClient(() => ({ ...ok(), usage: USAGE }));
      const dbError = new Error('db down');
      await assert.rejects(
        call(createAnthropicLlm(client), async () => {
          throw dbError;
        }),
        (error) => error === dbError,
      );
      // 응답을 받은 뒤의 실패라 다시 호출하지 않는다
      assert.equal(calls.length, 1);
    });
  }

  for (const [name, reply] of [
    ['토큰 초과로 잘린 JSON', () => jsonReply('{"answer":"잘린', 'max_tokens')],
    ['JSON 이 아닌 거절 문장', () => jsonReply('도와드릴 수 없습니다.', 'refusal')],
    ['스키마에 맞지 않는 JSON', () => jsonReply('{"answer":1}')],
  ] as const) {
    it(`parse: ${name}도 사용량을 남기고 llm_failed`, async () => {
      const { client, calls } = fakeClient(() => ({ ...reply(), usage: USAGE }));
      const reported: number[] = [];
      await rejectsLlmFailed(
        createAnthropicLlm(client).parse({
          ...parseReq,
          onUsage: (tokens) => {
            reported.push(tokens);
          },
        }),
      );
      assert.deepEqual(reported, [37]);
      assert.equal(calls.length, 1);
    });
  }
});
