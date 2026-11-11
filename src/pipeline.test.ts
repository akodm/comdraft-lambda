import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z } from 'zod';
import type { CommitDetail } from './github.ts';
import type { JobContext } from './jobs.ts';
import type { PreparedLink } from './generation/links.ts';
import { estimateJobTokens } from './generation/estimate.ts';
import { estimateTokens } from './generation/limits.ts';
import type { LlmClient } from './generation/llm.ts';
import type { Analysis, Plan } from './generation/schemas.ts';
import {
  createClaudePipeline,
  type PipelineInput,
} from './pipeline.ts';
import { getPromptPack } from './prompts/index.ts';
import { renderCatalog } from './prompts/render.ts';

const CONTEXT: JobContext = {
  prompt: '지연 로딩 적용기를 써 줘',
  tone: 'plain',
  postType: 'experience',
  length: 'medium',
  requiredBlocks: [],
  locale: 'ko',
  referenceUrls: ['https://example.com/post'],
  commitShas: ['bbbb2222', 'aaaa1111'],
  owner: 'o',
  repo: 'r',
};

const PATCH = '@@ -1,2 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;';

// 입력은 최신순이라 aaaa1111 이 C1, bbbb2222 가 C2
const COMMITS: CommitDetail[] = [
  {
    sha: 'bbbb2222',
    message: 'fix: edge case',
    htmlUrl: 'https://github.com/o/r/commit/bbbb2222',
    files: [{ filename: 'src/b.ts', status: 'modified', additions: 1, deletions: 0, patch: PATCH }],
  },
  {
    sha: 'aaaa1111',
    message: 'feat: lazy image',
    htmlUrl: 'https://github.com/o/r/commit/aaaa1111',
    files: [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: PATCH }],
  },
];

const LINKS: PreparedLink[] = [
  { id: 'L1', url: 'https://example.com/post', title: '참고 글', text: 'lazy loading notes' },
];

const PLAN: Plan = {
  title: '지연 로딩',
  takeaway: '이미지를 늦게 불러온다',
  sections: [
    { level: 2, heading: '적용', purpose: '코드', hunks: ['C1.F1.H1', 'C9.F1.H1'], links: ['L1', 'L9'] },
  ],
  excludedCommits: [],
};

const ANALYSIS: Analysis = {
  facts: [{ id: 'F1', section: 0, text: '지연 로딩을 넣었다', evidence: ['C1'] }],
  code: [
    { id: 'S1', section: 0, from: 'C1.F1.H1', startLine: 1, endLine: 4, mode: 'after', point: '값 변경' },
    // 선택되지 않은 hunk 를 가리키는 선택은 버려져야 한다
    { id: 'S2', section: 0, from: 'C2.F1.H1', startLine: 1, endLine: 2, mode: 'after', point: '못 본 코드' },
  ],
  unknowns: [{ id: 'U1', section: 0, kind: 'motivation', ask: '왜 했나' }],
};

const MARKDOWN = '# 지연 로딩\n\n## 적용\n\n지연 로딩을 넣었다 {{commit:C1}}\n\n{{code:S1}}\n\n{{ask:U1}}';

interface ParseCall {
  system: string;
  user: string;
  effort: string;
  maxTokens: number;
  onUsage?: (tokens: number) => void | Promise<void>;
}

// 가짜 LLM 이 호출마다 보고하는 사용량
const CALL_USAGE = 100;

const fakeLlm = (plan: Plan, analysis: Analysis, markdown: string) => {
  const parses: ParseCall[] = [];
  const writes: ParseCall[] = [];
  let parseIndex = 0;
  const llm: LlmClient = {
    parse: async <T>(req: {
      system: string;
      user: string;
      schema: z.ZodType<T>;
      effort: 'low' | 'medium';
      maxTokens: number;
      onUsage?: (tokens: number) => void | Promise<void>;
    }) => {
      parses.push(req);
      await req.onUsage?.(CALL_USAGE);
      const result = parseIndex === 0 ? plan : analysis;
      parseIndex += 1;
      return result as T;
    },
    write: async (req) => {
      writes.push(req);
      await req.onUsage?.(CALL_USAGE);
      return markdown;
    },
  };
  return { llm, parses, writes };
};

const run = async (
  llm: LlmClient,
  options: {
    context?: Partial<JobContext>;
    commits?: CommitDetail[];
    fetchLinks?: (urls: string[]) => Promise<PreparedLink[]>;
  } = {},
) => {
  const pipeline = createClaudePipeline({
    llm,
    fetchLinks: options.fetchLinks ?? (async () => LINKS),
  });
  const usage: number[] = [];
  const input: PipelineInput = {
    context: { ...CONTEXT, ...options.context },
    commits: options.commits ?? COMMITS,
    onUsage: async (tokens) => {
      usage.push(tokens);
    },
  };
  const prepared = await pipeline.prepare(input);
  const estimate = pipeline.estimate(input, prepared);
  const classified = await pipeline.classify(input, prepared);
  const analyzed = await pipeline.analyze(input, classified);
  const markdown = await pipeline.write(input, analyzed);
  return { prepared, estimate, classified, analyzed, markdown, usage };
};

// 준비와 예상량만 계산한다 (Claude 는 부르지 않음)
const prepareOnly = async (
  options: { context?: Partial<JobContext>; links?: PreparedLink[] } = {},
) => {
  const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
  const pipeline = createClaudePipeline({ llm, fetchLinks: async () => options.links ?? LINKS });
  const input: PipelineInput = {
    context: { ...CONTEXT, ...options.context },
    commits: COMMITS,
    onUsage: async () => {},
  };
  const prepared = await pipeline.prepare(input);
  return { prepared, estimate: pipeline.estimate(input, prepared), calls: parses.length + writes.length };
};

describe('createClaudePipeline', () => {
  it('세 단계를 거쳐 코드·빈칸이 치환된 Markdown 을 만든다', async () => {
    const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const { markdown } = await run(llm);

    assert.ok(markdown.includes('```ts\nconst a = 1;\nconst b = 3;\nconst c = 4;\n```'));
    // 커밋 자리표시자는 링크가 되지 않고 사라진다
    assert.ok(!markdown.includes('github.com/o/r/commit'));
    assert.ok(!markdown.includes('aaaa111'));
    assert.ok(markdown.includes(':::blank {kind="motivation" hint="왜 했나"}\n:::'));
    assert.ok(!markdown.includes('{{'));
    assert.deepEqual(
      parses.map(({ effort, maxTokens }) => [effort, maxTokens]),
      [['low', 8_000], ['medium', 16_000]],
    );
    assert.deepEqual(
      writes.map(({ effort, maxTokens }) => [effort, maxTokens]),
      [['medium', 16_000]],
    );
  });

  it('분석 단계에는 기획이 고른 hunk 만 들어간다', async () => {
    const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const { classified, analyzed } = await run(llm);

    // 기획 검증이 없는 hunk(C9)·링크(L9)를 걸러 낸다
    assert.deepEqual(classified.plan.sections[0].hunks, ['C1.F1.H1']);
    assert.deepEqual(classified.plan.sections[0].links, ['L1']);
    // 고르지 않은 C2 의 hunk 는 분석 프롬프트에 없고, 그걸 가리킨 코드 선택은 버려진다
    assert.ok(parses[1].user.includes('C1.F1.H1'));
    assert.ok(!parses[1].user.includes('C2.F1.H1'));
    assert.deepEqual(analyzed.analysis.code.map((pick) => pick.id), ['S1']);
    assert.ok(!writes[0].user.includes('C2.F1.H1'));
  });

  it('분석 결과의 빈칸은 길이별 상한까지만 남고, 버린 빈칸은 작성 입력에 없다', async () => {
    const analysis: Analysis = {
      ...ANALYSIS,
      unknowns: ['U1', 'U2', 'U3', 'U4'].map((id) => ({
        id,
        section: 0,
        kind: 'detail' as const,
        ask: `${id} 질문`,
      })),
    };
    const { llm, writes } = fakeLlm(PLAN, analysis, '# 지연 로딩\n\n## 적용\n\n{{ask:U1}}\n\n{{ask:U3}}');
    const { analyzed, markdown } = await run(llm);

    assert.deepEqual(analyzed.analysis.unknowns.map((u) => u.id), ['U1', 'U2']);
    assert.ok(writes[0].user.includes('<blank id="U2"'));
    assert.ok(!writes[0].user.includes('<blank id="U3"'));
    assert.ok(!writes[0].user.includes('U4 질문'));
    // 모델이 버린 빈칸을 써도 조립 단계가 넣지 않는다
    assert.equal(markdown.match(/:::blank/g)?.length, 1);

    const short = fakeLlm(PLAN, analysis, MARKDOWN);
    const { analyzed: shortAnalyzed } = await run(short.llm, { context: { length: 'short' } });
    assert.deepEqual(shortAnalyzed.analysis.unknowns.map((u) => u.id), ['U1']);
  });

  it('로케일 en 이면 en 프롬프트를 쓴다', async () => {
    const ko = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const en = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    await run(ko.llm);
    const { markdown } = await run(en.llm, { context: { locale: 'en' } });

    assert.notEqual(en.parses[0].system, ko.parses[0].system);
    assert.notEqual(en.writes[0].system, ko.writes[0].system);
    assert.ok(!/[가-힣]/.test(en.parses[0].system));
    assert.ok(/[가-힣]/.test(ko.parses[0].system));
    assert.ok(markdown.includes('```ts'));
  });

  it('본문 없는 커밋만 있어도 빈칸으로 글을 만든다', async () => {
    const lockOnly: CommitDetail[] = [
      {
        sha: 'cccc3333',
        message: 'chore: bump',
        htmlUrl: 'https://github.com/o/r/commit/cccc3333',
        files: [{ filename: 'pnpm-lock.yaml', status: 'modified', additions: 5, deletions: 5, patch: PATCH }],
      },
    ];
    const plan: Plan = {
      ...PLAN,
      sections: [{ level: 2, heading: '정리', purpose: '의존성', hunks: [], links: [] }],
    };
    const analysis: Analysis = {
      facts: [],
      code: [],
      unknowns: [{ id: 'U1', section: 0, kind: 'detail', ask: '무엇을 올렸나' }],
    };
    const { llm } = fakeLlm(plan, analysis, '# 의존성\n\n## 정리\n\n{{ask:U1}}');
    const { markdown } = await run(llm, { commits: lockOnly, context: { referenceUrls: [] } });

    assert.ok(markdown.includes(':::blank {kind="detail" hint="무엇을 올렸나"}'));
  });

  it('링크 가져오기 실패는 작업을 멈추지 않는다', async () => {
    const { llm, parses } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const { classified, markdown } = await run(llm, {
      fetchLinks: async () => {
        throw new Error('network down');
      },
    });

    assert.deepEqual(classified.links, []);
    assert.deepEqual(classified.plan.sections[0].links, []);
    assert.ok(!parses[0].user.includes('example.com/post'));
    assert.ok(markdown.includes(':::blank'));
  });

  it('준비와 예상량 계산은 Claude 를 부르지 않는다', async () => {
    const { prepared, estimate, calls } = await prepareOnly();

    assert.equal(calls, 0);
    assert.deepEqual(prepared.commits.map((commit) => commit.id), ['C1', 'C2']);
    assert.deepEqual(prepared.links, LINKS);

    // 실제 system 프롬프트·카탈로그·hunk 본문(커밋 두 개의 같은 PATCH)·링크·요청을 잰 값과 같다
    const pack = getPromptPack('ko');
    const hunkBody = PATCH.split('\n').slice(1).join('\n');
    assert.equal(
      estimate,
      estimateJobTokens(
        {
          catalogTokens: estimateTokens(renderCatalog(prepared.commits)),
          hunkTokens: estimateTokens(hunkBody) * 2,
          linkTokens: estimateTokens(LINKS[0].text),
          requestTokens: estimateTokens(CONTEXT.prompt),
        },
        'medium',
        {
          plan: estimateTokens(pack.plan.system),
          analyze: estimateTokens(pack.analyze.system),
          write: estimateTokens(pack.write.system),
        },
      ),
    );
  });

  it('가린 hunk 본문은 예상량에 넣지 않는다', async () => {
    const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const pipeline = createClaudePipeline({ llm, fetchLinks: async () => [] });
    const estimateFor = async (patch: string) => {
      const input: PipelineInput = {
        context: { ...CONTEXT, referenceUrls: [] },
        commits: [{ ...COMMITS[1], files: [{ ...COMMITS[1].files[0], patch }] }],
        onUsage: async () => {},
      };
      const prepared = await pipeline.prepare(input);
      return {
        estimate: pipeline.estimate(input, prepared),
        catalog: estimateTokens(renderCatalog(prepared.commits)),
        redacted: [...prepared.hunks.values()].every((hunk) => hunk.redacted),
      };
    };
    const secret = `@@ -1 +1 @@\n+const key = 'ghp_${'a'.repeat(36)}';\n${'+// 설명\n'.repeat(50)}`;
    const plain = await estimateFor(PATCH);
    const hidden = await estimateFor(secret);

    assert.equal(hidden.redacted, true);
    // 가린 hunk 는 카탈로그 차이만큼만 달라지고 본문은 0 으로 센다
    assert.equal(
      hidden.estimate - hidden.catalog,
      plain.estimate - plain.catalog - estimateTokens(PATCH.split('\n').slice(1).join('\n')),
    );
  });

  it('예상량은 링크 본문과 글 길이에 따라 커진다', async () => {
    const text = '참고 '.repeat(500);
    const withoutLinks = await prepareOnly({ links: [] });
    const withLinks = await prepareOnly({ links: [{ ...LINKS[0], text }] });
    const long = await prepareOnly({ links: [], context: { length: 'long' } });

    assert.equal(withLinks.estimate, withoutLinks.estimate + estimateTokens(text));
    assert.ok(long.estimate > withoutLinks.estimate);
  });

  it('모든 Claude 호출의 사용량을 onUsage 로 보고한다', async () => {
    const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
    const { usage } = await run(llm);

    assert.deepEqual(usage, [CALL_USAGE, CALL_USAGE, CALL_USAGE]);
  });
});
