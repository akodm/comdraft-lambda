import type Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { GenerationFailure } from '../errors.ts';
import { createAnthropicLlm, GENERATION_MODEL, LLM_TIMEOUT_MS } from './llm.ts';

type Req = Record<string, any>;

// 가짜 SDK 클라이언트: 받은 요청과 옵션을 기록하고 정해 둔 응답(또는 오류)을 돌려준다
const fakeClient = (reply: () => unknown) => {
  const calls: { method: 'parse' | 'stream'; req: Req; options: Req }[] = [];
  const client = {
    messages: {
      parse: async (req: Req, options: Req) => {
        calls.push({ method: 'parse', req, options });
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
  it('model·effort·max_tokens·format 을 보내고 sampling·thinking 은 보내지 않는다', async () => {
    const { client, calls } = fakeClient(() => ({
      stop_reason: 'end_turn',
      parsed_output: { answer: 'ok' },
    }));

    const result = await createAnthropicLlm(client).parse(parseReq);

    assert.deepEqual(result, { answer: 'ok' });
    const { method, req, options } = calls[0];
    assert.equal(method, 'parse');
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
  });

  for (const stop_reason of ['refusal', 'max_tokens']) {
    it(`stop_reason ${stop_reason} 는 llm_failed`, async () => {
      const { client } = fakeClient(() => ({ stop_reason, parsed_output: { answer: 'x' } }));
      await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
    });
  }

  it('parsed_output 이 null 이면 llm_failed', async () => {
    const { client } = fakeClient(() => ({ stop_reason: 'end_turn', parsed_output: null }));
    await rejectsLlmFailed(createAnthropicLlm(client).parse(parseReq));
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
