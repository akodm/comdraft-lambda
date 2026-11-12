import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FILL_TARGET_MARKER } from './contract.ts';
import { GenerationFailure } from './errors.ts';
import { createClaudeFiller, FILL_STAGE, type FillInput } from './fill.ts';
import { ESTIMATE_FILL_OUTPUT, estimateTokens } from './generation/limits.ts';
import type { LlmClient } from './generation/llm.ts';
import type { StoredAnalysis } from './generation/stored-analysis.ts';
import type { JobBlank, JobContext } from './jobs.ts';
import { getPromptPack } from './prompts/index.ts';

const BLANK: JobBlank = {
  id: '6f1c2a4e-0000-4000-8000-000000000001',
  question: '첫 화면이 얼마나 느렸나요?',
  answer: '3초 정도 걸렸다. useLazyImage 로 고쳤다',
  context: `# 지연 로딩\n\n앞 문단이다.\n\n${FILL_TARGET_MARKER}\n\n뒤 문단이다.`,
};

const CONTEXT: JobContext = {
  kind: 'fill',
  prompt: BLANK.answer,
  tone: 'plain',
  postType: 'experience',
  length: 'medium',
  requiredBlocks: [],
  locale: 'ko',
  referenceUrls: [],
  commitShas: [],
  owner: 'o',
  repo: 'r',
  clarification: null,
  clarificationAsked: false,
  blank: BLANK,
};

const ANALYSIS: StoredAnalysis = {
  version: 1,
  sections: [{ heading: '느린 첫 화면', facts: ['이미지를 모두 먼저 불러왔다'], points: [], questions: [] }],
};

interface WriteCall {
  system: string;
  user: string;
  effort: string;
  maxTokens: number;
}

const fakeLlm = (markdown: string, usage = 700) => {
  const writes: WriteCall[] = [];
  let parses = 0;
  const llm: LlmClient = {
    parse: async () => {
      parses += 1;
      throw new Error('빈칸 채우기는 parse 를 쓰지 않는다');
    },
    write: async (req) => {
      writes.push(req);
      await req.onUsage?.(usage);
      return markdown;
    },
  };
  return { llm, writes, parses: () => parses };
};

const input = (overrides: Partial<FillInput> = {}): FillInput & { usage: number[] } => {
  const usage: number[] = [];
  return {
    context: CONTEXT,
    blank: BLANK,
    analysis: ANALYSIS,
    onUsage: async (tokens) => {
      usage.push(tokens);
    },
    usage,
    ...overrides,
  };
};

describe('createClaudeFiller', () => {
  it('예상량 = system + 사용자 입력(본문·재료·질문·답) + 출력 여유분', () => {
    const { llm, writes } = fakeLlm('문단');
    const filler = createClaudeFiller({ llm });
    const pack = getPromptPack('ko');
    const args = input();

    assert.equal(ESTIMATE_FILL_OUTPUT, 1_500);
    assert.equal(
      filler.estimate(args),
      estimateTokens(pack.fill.system) +
        estimateTokens(pack.fill.user({ context: CONTEXT, blank: BLANK, analysis: ANALYSIS })) +
        ESTIMATE_FILL_OUTPUT,
    );
    // 재료가 없으면 그만큼 작다
    assert.ok(filler.estimate(input({ analysis: null })) < filler.estimate(args));
    assert.equal(writes.length, 0);
  });

  it('Claude 를 한 번 부르고 사용량을 보고하며, 정리한 문단을 돌려준다', async () => {
    const { llm, writes, parses } = fakeLlm(
      '## 제목\n\n첫 화면이 3초 정도 걸렸다. [링크](https://evil.example)\n\n```\ncode\n```\n\n`useLazyImage` 로 고쳤다.',
    );
    const args = input();
    const result = await createClaudeFiller({ llm }).fill(args);

    assert.equal(writes.length, 1);
    assert.equal(parses(), 0);
    assert.deepEqual(args.usage, [700]);
    assert.deepEqual([writes[0].effort, writes[0].maxTokens], [FILL_STAGE.effort, FILL_STAGE.maxTokens]);
    assert.equal(writes[0].system, getPromptPack('ko').fill.system);
    assert.ok(writes[0].user.includes('<answer>\n3초 정도 걸렸다. useLazyImage 로 고쳤다\n</answer>'));
    assert.ok(!result.includes('#'), result);
    assert.ok(!result.includes('evil.example'), result);
    assert.ok(!result.includes('```'), result);
    // 답에 나온 식별자는 인라인 코드로 남는다
    assert.ok(result.includes('`useLazyImage`'), result);
  });

  it('재료가 없어도 본문과 답만으로 다듬는다', async () => {
    const { llm, writes } = fakeLlm('첫 화면이 3초 정도 걸렸다.');
    const result = await createClaudeFiller({ llm }).fill(input({ analysis: null }));

    assert.equal(writes.length, 1);
    assert.ok(!writes[0].user.includes('<analysis>'));
    assert.equal(result, '첫 화면이 3초 정도 걸렸다.');
  });

  it('로케일 en 이면 en 프롬프트를 쓴다', async () => {
    const { llm, writes } = fakeLlm('It took about three seconds.');
    await createClaudeFiller({ llm }).fill(input({ context: { ...CONTEXT, locale: 'en' } }));

    assert.equal(writes[0].system, getPromptPack('en').fill.system);
  });

  it('정리 후 남는 글이 없으면 invalid_result', async () => {
    const { llm } = fakeLlm('# 제목만');

    await assert.rejects(
      createClaudeFiller({ llm }).fill(input()),
      (error) => error instanceof GenerationFailure && error.code === 'invalid_result',
    );
  });
});
