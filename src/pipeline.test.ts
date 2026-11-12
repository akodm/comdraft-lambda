import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z } from 'zod';
import type { CommitDetail } from './github.ts';
import type { GenerationClarification } from './contract.ts';
import type { JobContext } from './jobs.ts';
import type { PreparedLink } from './generation/links.ts';
import { estimateJobTokens } from './generation/estimate.ts';
import { estimateTokens, REVIEW_MIN_REMAINING_MS, REVISE_MIN_REMAINING_MS } from './generation/limits.ts';
import { GenerationFailure } from './errors.ts';
import type { Effort, LlmClient } from './generation/llm.ts';
import type { Analysis, RawPlan } from './generation/schemas.ts';
import type { StoredAnalysis } from './generation/stored-analysis.ts';
import {
  createClaudePipeline,
  type PipelineInput,
} from './pipeline.ts';
import { getPromptPack } from './prompts/index.ts';
import { renderCatalog } from './prompts/render.ts';

const CONTEXT: JobContext = {
  kind: 'draft',
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
  clarification: null,
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

const PLAN: RawPlan = {
  title: '지연 로딩',
  takeaway: '이미지를 늦게 불러온다',
  sections: [
    { level: 2, heading: '적용', purpose: '코드', hunks: ['C1.F1.H1', 'C9.F1.H1'], links: ['L1', 'L9'] },
  ],
  excludedCommits: [],
  linkRoles: [],
  clarify: { needed: false, reason: '', questions: [] },
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

// 응답은 값이면 그대로 돌려주고 Error 면 던진다
type Reply<T> = T | Error;

const reply = <T>(value: Reply<T>): T => {
  if (value instanceof Error) {
    throw value;
  }
  return value;
};

const NO_ISSUES = { issues: [] };

// parse 응답은 호출 순서대로 (기획, 분석, 검토), write 응답도 (작성, 고쳐 쓰기)
// 검토 응답을 따로 주지 않으면 문제 없음으로 답한다
const fakeLlm = (
  plan: RawPlan,
  analysis: Analysis,
  markdown: string,
  // replan: 필수 제목 수준이 빠져 다시 기획한 결과 / retried: 고쳐 쓴 초안이 거절됐을 때 다시 고쳐 쓴 결과 (없으면 revised 와 같음)
  extra: { replan?: Reply<unknown>; review?: Reply<unknown>; revised?: Reply<string>; retried?: Reply<string> } = {},
) => {
  const parses: ParseCall[] = [];
  const writes: ParseCall[] = [];
  const parseReplies: Reply<unknown>[] = [
    plan,
    ...(extra.replan === undefined ? [] : [extra.replan]),
    analysis,
    extra.review ?? NO_ISSUES,
  ];
  const writeReplies: Reply<string>[] = [
    markdown,
    extra.revised ?? markdown,
    extra.retried ?? extra.revised ?? markdown,
  ];
  let parseIndex = 0;
  let writeIndex = 0;
  const llm: LlmClient = {
    parse: async <T>(req: {
      system: string;
      user: string;
      schema: z.ZodType<T>;
      effort: Effort;
      maxTokens: number;
      onUsage?: (tokens: number) => void | Promise<void>;
    }) => {
      parses.push(req);
      await req.onUsage?.(CALL_USAGE);
      const result = reply(parseReplies[parseIndex]);
      parseIndex += 1;
      return result as T;
    },
    write: async (req) => {
      writes.push(req);
      await req.onUsage?.(CALL_USAGE);
      const result = reply(writeReplies[writeIndex]);
      writeIndex += 1;
      return result;
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
    remainingTimeMs?: () => number;
  } = {},
) => {
  const errors: unknown[] = [];
  const pipeline = createClaudePipeline({
    llm,
    fetchLinks: options.fetchLinks ?? (async () => LINKS),
    remainingTimeMs: options.remainingTimeMs ?? (() => 300_000),
    reportError: (error) => {
      errors.push(error);
    },
  });
  const usage: number[] = [];
  const stored: StoredAnalysis[] = [];
  const input: PipelineInput = {
    context: { ...CONTEXT, ...options.context },
    commits: options.commits ?? COMMITS,
    onUsage: async (tokens) => {
      usage.push(tokens);
    },
    onAnalysis: async (analysis) => {
      stored.push(analysis);
    },
  };
  const prepared = await pipeline.prepare(input);
  const estimate = pipeline.estimate(input, prepared);
  const classified = await pipeline.classify(input, prepared);
  const analyzed = await pipeline.analyze(input, classified);
  const written = await pipeline.write(input, analyzed);
  const markdown = await pipeline.review(input, written);
  return { prepared, estimate, classified, analyzed, written, markdown, usage, stored, errors };
};

// 준비와 예상량만 계산한다 (Claude 는 부르지 않음)
const prepareOnly = async (
  options: { context?: Partial<JobContext>; links?: PreparedLink[] } = {},
) => {
  const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
  const pipeline = createClaudePipeline({
    llm,
    fetchLinks: async () => options.links ?? LINKS,
    remainingTimeMs: () => 300_000,
  });
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
      // 분석은 입력이 커서 medium 이면 생각만으로 출력 상한을 다 쓸 수 있어 low (작성은 medium)
      // Haiku 로 품질을 끌어올리려고 사고 깊이와 출력 상한을 올렸다 (Lambda 900초, 호출 하나 180초)
      [['medium', 16_000], ['medium', 32_000], ['medium', 16_000]],
    );
    assert.deepEqual(
      writes.map(({ effort, maxTokens }) => [effort, maxTokens]),
      [['high', 32_000]],
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

  describe('필수 제목 수준', () => {
    const H3_CONTEXT = { requiredBlocks: ['h2', 'h3'] };
    const WITH_H3: RawPlan = {
      ...PLAN,
      sections: [PLAN.sections[0], { level: 3, heading: '세부', purpose: '나눔', hunks: [], links: [] }],
    };

    it('필수 h3 이 기획에 없으면 빠진 수준을 알려 주고 한 번만 다시 기획한다', async () => {
      // 실제 비교 실행: h2·h3·list·code 를 골랐는데 모든 절이 h2 였다
      const { llm, parses } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { replan: WITH_H3 });
      const { classified } = await run(llm, { context: H3_CONTEXT });

      assert.equal(parses.length, 4);
      assert.ok(!parses[0].user.includes('앞선 기획에서 빠진 것'));
      assert.ok(parses[1].user.includes('앞선 기획에서 빠진 것'));
      assert.ok(parses[1].user.includes('h3'));
      assert.deepEqual(classified.plan.sections.map((section) => section.level), [2, 3]);
    });

    it('다시 기획해도 빠졌으면 처음 기획을 쓰고 더 시도하지 않는다', async () => {
      const { llm, parses } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { replan: { ...PLAN, title: '다른 기획' } });
      const { classified } = await run(llm, { context: H3_CONTEXT });

      assert.equal(parses.length, 4);
      assert.equal(classified.plan.title, PLAN.title);
    });

    it('필수 제목 수준이 없거나 이미 있으면 다시 기획하지 않는다', async () => {
      const none = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
      await run(none.llm);
      assert.equal(none.parses.length, 3);

      const present = fakeLlm(WITH_H3, ANALYSIS, MARKDOWN);
      await run(present.llm, { context: H3_CONTEXT });
      assert.equal(present.parses.length, 3);
    });
  });

  describe('되묻기', () => {
    const ASKING: RawPlan = {
      ...PLAN,
      clarify: {
        needed: true,
        reason: '독자가 갈린다',
        questions: [{ question: '누구를 위한 글인가요?', options: ['입문자', '실무자'] }],
      },
    };
    const H3_CONTEXT = { requiredBlocks: ['h2', 'h3'] };
    const WITH_H3: RawPlan = {
      ...PLAN,
      sections: [PLAN.sections[0], { level: 3, heading: '세부', purpose: '나눔', hunks: [], links: [] }],
    };
    const answered: GenerationClarification = {
      reason: '독자가 갈린다',
      questions: [{ id: 'Q1', question: '누구를 위한 글인가요?', options: ['입문자', '실무자'] }],
      answers: [{ id: 'Q1', answer: '입문자 대상으로 써 주세요' }],
    };
    const asked: GenerationClarification = { ...answered, answers: null };

    // 기획 단계까지만 실행한다
    const classifyOnly = async (llm: LlmClient, context: Partial<JobContext> = {}) => {
      const pipeline = createClaudePipeline({
        llm,
        fetchLinks: async () => LINKS,
        remainingTimeMs: () => 300_000,
      });
      const input: PipelineInput = {
        context: { ...CONTEXT, ...context },
        commits: COMMITS,
        onUsage: async () => {},
      };
      const prepared = await pipeline.prepare(input);
      const classified = await pipeline.classify(input, prepared);
      return { pipeline, classified };
    };

    it('처음 실행에서 기획이 묻기로 하면 다시 기획하지 않고 clarify 를 돌려준다', async () => {
      // 필수 h3 이 빠졌어도 묻기가 먼저다
      const { llm, parses } = fakeLlm(ASKING, ANALYSIS, MARKDOWN, { replan: WITH_H3 });
      const { pipeline, classified } = await classifyOnly(llm, H3_CONTEXT);

      assert.equal(parses.length, 1);
      assert.deepEqual(pipeline.clarification(classified), {
        reason: '독자가 갈린다',
        questions: [{ id: 'Q1', question: '누구를 위한 글인가요?', options: ['입문자', '실무자'] }],
      });
    });

    it('묻지 않기로 한 기획은 clarification 이 null 이다', async () => {
      const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
      const { pipeline, classified } = await classifyOnly(llm);

      assert.equal(pipeline.clarification(classified), null);
    });

    it('이미 물은 작업은 기획이 묻기로 해도 무시한다', async () => {
      for (const clarification of [asked, answered, { ...asked, answers: 'skipped' as const }]) {
        const { llm, parses } = fakeLlm(ASKING, ANALYSIS, MARKDOWN);
        const { pipeline, classified } = await classifyOnly(llm, { clarification });

        assert.equal(parses.length, 1);
        assert.equal(classified.plan.clarify, null);
        assert.equal(pipeline.clarification(classified), null);
      }
    });

    it('이미 물은 작업은 필수 제목이 빠지면 기존처럼 다시 기획한다', async () => {
      const { llm, parses } = fakeLlm(ASKING, ANALYSIS, MARKDOWN, { replan: WITH_H3 });
      const { classified } = await classifyOnly(llm, { ...H3_CONTEXT, clarification: answered });

      assert.equal(parses.length, 2);
      assert.deepEqual(classified.plan.sections.map((section) => section.level), [2, 3]);
    });

    it('다시 기획한 결과의 clarify 는 무시한다', async () => {
      // 처음 기획은 묻지 않지만 h3 이 빠져 다시 기획했고, 그 기획이 묻기로 했다
      const { llm, parses } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { replan: { ...WITH_H3, clarify: ASKING.clarify } });
      const { pipeline, classified } = await classifyOnly(llm, H3_CONTEXT);

      assert.equal(parses.length, 2);
      assert.deepEqual(classified.plan.sections.map((section) => section.level), [2, 3]);
      assert.equal(classified.plan.clarify, null);
      assert.equal(pipeline.clarification(classified), null);
    });

    it('답한 맥락이 기획·분석·작성·검토 입력에 들어간다', async () => {
      const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { review: { issues: [] } });
      await run(llm, { context: { clarification: answered } });

      for (const call of [...parses, writes[0]]) {
        assert.ok(call.user.includes('<clarification>'));
        assert.ok(call.user.includes('입문자 대상으로 써 주세요'));
      }
    });

    it('예상량에 답 길이가 들어간다', async () => {
      const plain = await prepareOnly();
      const withAnswer = await prepareOnly({ context: { clarification: answered } });
      const longAnswer = await prepareOnly({
        context: {
          clarification: { ...answered, answers: [{ id: 'Q1', answer: '긴 답변 '.repeat(200) }] },
        },
      });

      assert.ok(withAnswer.estimate > plain.estimate);
      assert.ok(longAnswer.estimate > withAnswer.estimate);
    });
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
    const plan: RawPlan = {
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
    const pipeline = createClaudePipeline({
      llm,
      fetchLinks: async () => [],
      remainingTimeMs: () => 300_000,
    });
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

    assert.deepEqual(usage, [CALL_USAGE, CALL_USAGE, CALL_USAGE, CALL_USAGE]);
  });

  it('분석 단계는 검증한 분석을 저장용으로 한 번 넘긴다 (코드 원문·근거 없이, 상한을 넘은 빈칸 없이)', async () => {
    const analysis: Analysis = {
      ...ANALYSIS,
      unknowns: ['U1', 'U2', 'U3'].map((id) => ({ id, section: 0, kind: 'detail' as const, ask: `${id} 질문` })),
    };
    const { llm } = fakeLlm(PLAN, analysis, MARKDOWN);
    const { stored } = await run(llm);

    assert.deepEqual(stored, [
      {
        version: 1,
        sections: [{ heading: '적용', facts: ['지연 로딩을 넣었다'], points: ['값 변경'], questions: ['U1 질문', 'U2 질문'] }],
      },
    ]);
    const text = JSON.stringify(stored);
    assert.ok(!text.includes('const b'), text);
    assert.ok(!text.includes('C1'), text);
  });

  describe('검토 단계', () => {
    const ISSUE = { kind: 'unsupported', quote: '지연 로딩을 넣었다', fix: '근거 없는 단정을 줄인다' };
    const REVISED = MARKDOWN.replace('지연 로딩을 넣었다', '이미지를 늦게 불러오도록 바꿨다');

    it('검토에 문제가 없으면 고쳐 쓰지 않고 원래 초안을 조립한다', async () => {
      const { llm, parses, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
      const { markdown, errors } = await run(llm);

      assert.equal(parses.length, 3);
      assert.equal(writes.length, 1);
      assert.ok(markdown.includes('지연 로딩을 넣었다'));
      assert.deepEqual(errors, []);
    });

    it('검토에 문제가 있으면 고쳐 쓴 초안을 조립한다', async () => {
      const { llm, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: REVISED,
      });
      const { markdown, errors } = await run(llm);

      assert.equal(writes.length, 2);
      assert.ok(writes[1].user.includes('<issue kind='));
      assert.ok(markdown.includes('이미지를 늦게 불러오도록 바꿨다'));
      assert.ok(!markdown.includes('지연 로딩을 넣었다'));
      assert.ok(markdown.includes('```ts'));
      assert.deepEqual(errors, []);
    });

    it('검토 실패(timeout 포함)·고쳐 쓰기 실패·고쳐 쓴 초안 거절이면 원래 초안을 조립하고 reportError 를 부른다', async () => {
      const reviewFails = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: new GenerationFailure('timeout'),
      });
      const reviewResult = await run(reviewFails.llm);
      assert.ok(reviewResult.markdown.includes('지연 로딩을 넣었다'));
      assert.equal((reviewResult.errors[0] as GenerationFailure).code, 'timeout');

      const reviseFails = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: new GenerationFailure('internal'),
      });
      const reviseResult = await run(reviseFails.llm);
      assert.ok(reviseResult.markdown.includes('지연 로딩을 넣었다'));
      assert.equal(reviseResult.errors.length, 1);

      const rejected = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: REVISED.replace('{{code:S1}}', ''),
      });
      const rejectedResult = await run(rejected.llm);
      assert.ok(rejectedResult.markdown.includes('지연 로딩을 넣었다'));
      assert.ok(rejectedResult.markdown.includes('```ts'));
      assert.equal((rejectedResult.errors[0] as GenerationFailure).code, 'invalid_result');
    });

    it('고쳐 쓴 초안이 거절되면 이유를 알려 주고 한 번만 다시 고쳐 쓴다', async () => {
      // 실제 비교 실행: 검토 지적을 따르다 빈칸을 지워 고쳐 쓰기 전체가 버려졌다
      const dropsBlank = REVISED.replace('{{ask:U1}}', '');
      const recovered = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: dropsBlank,
        retried: REVISED,
      });
      const recoveredResult = await run(recovered.llm);
      assert.equal(recovered.writes.length, 3);
      assert.ok(!recovered.writes[1].user.includes('앞선 고쳐 쓰기를 쓰지 못한 이유'));
      assert.ok(recovered.writes[2].user.includes('앞선 고쳐 쓰기를 쓰지 못한 이유'));
      assert.ok(recovered.writes[2].user.includes('{{ask:U1}}'));
      assert.ok(recoveredResult.markdown.includes('이미지를 늦게 불러오도록 바꿨다'));
      assert.equal(recoveredResult.errors.length, 1);

      // 다시 고쳐 써도 거절되면 원래 초안 (더 시도하지 않음)
      const stillBad = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: dropsBlank,
        retried: dropsBlank,
      });
      const stillBadResult = await run(stillBad.llm);
      assert.equal(stillBad.writes.length, 3);
      assert.ok(stillBadResult.markdown.includes('지연 로딩을 넣었다'));
      assert.equal(stillBadResult.errors.length, 2);
    });

    it('다시 고쳐 쓸 시간이 고쳐 쓰기 기준보다 적게 남았으면 다시 고쳐 쓰지 않는다', async () => {
      const { llm, writes } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: REVISED.replace('{{ask:U1}}', ''),
        retried: REVISED,
      });
      // 고쳐 쓰기 전까지는 넉넉하고, 첫 고쳐 쓰기를 마친 뒤에는 고쳐 쓰기 기준보다 1ms 적게 남는다
      let left = 300_000;
      const pipeline = createClaudePipeline({
        llm: {
          ...llm,
          write: async (req) => {
            const result = await llm.write(req);
            if (writes.length === 2) left = REVISE_MIN_REMAINING_MS - 1;
            return result;
          },
        },
        fetchLinks: async () => LINKS,
        remainingTimeMs: () => left,
      });
      const input: PipelineInput = { context: CONTEXT, commits: COMMITS, onUsage: async () => {} };
      const prepared = await pipeline.prepare(input);
      const analyzed = await pipeline.analyze(input, await pipeline.classify(input, prepared));
      const markdown = await pipeline.review(input, await pipeline.write(input, analyzed));

      assert.equal(writes.length, 2);
      assert.ok(markdown.includes('지연 로딩을 넣었다'));
    });

    it('모델 검토가 문제를 못 찾아도 패턴에 걸린 문장은 고쳐 쓰기에 넘긴다', async () => {
      // 실제 비교 실행: "자세한 이유는 뒤에서 다시 이야기할게요." 를 검토가 놓쳤다
      const withMeta = MARKDOWN.replace('지연 로딩을 넣었다', '지연 로딩을 넣었다. 자세한 이유는 뒤에서 다시 이야기할게요.');
      const { llm, writes } = fakeLlm(PLAN, ANALYSIS, withMeta, { revised: MARKDOWN });
      await run(llm);

      assert.equal(writes.length, 2);
      assert.ok(writes[1].user.includes('<quote>자세한 이유는 뒤에서 다시 이야기할게요.</quote>'));
    });

    it('reportError 가 없어도 검토 실패는 조용히 넘어간다', async () => {
      const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { review: new GenerationFailure('internal') });
      const pipeline = createClaudePipeline({
        llm,
        fetchLinks: async () => LINKS,
        remainingTimeMs: () => 300_000,
      });
      const input: PipelineInput = { context: CONTEXT, commits: COMMITS, onUsage: async () => {} };
      const prepared = await pipeline.prepare(input);
      const analyzed = await pipeline.analyze(input, await pipeline.classify(input, prepared));
      const markdown = await pipeline.review(input, await pipeline.write(input, analyzed));

      assert.ok(markdown.includes('지연 로딩을 넣었다'));
    });

    it('남은 시간이 검토 기준 미만이면 검토를, 고쳐 쓰기 기준 미만이면 고쳐 쓰기를 부르지 않는다', async () => {
      const noReview = fakeLlm(PLAN, ANALYSIS, MARKDOWN, { review: { issues: [ISSUE] } });
      const first = await run(noReview.llm, { remainingTimeMs: () => REVIEW_MIN_REMAINING_MS - 1 });
      assert.equal(noReview.parses.length, 2);
      assert.equal(noReview.writes.length, 1);
      assert.ok(first.markdown.includes('지연 로딩을 넣었다'));

      const noRevise = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: REVISED,
      });
      const second = await run(noRevise.llm, { remainingTimeMs: () => REVISE_MIN_REMAINING_MS - 1 });
      assert.equal(noRevise.parses.length, 3);
      assert.equal(noRevise.writes.length, 1);
      assert.ok(second.markdown.includes('지연 로딩을 넣었다'));
    });

    it('바깥 펜스로 감싼 작성 결과도 검토 quote 를 찾아 고쳐 쓴다', async () => {
      const fenced = `\`\`\`markdown\n${MARKDOWN}\n\`\`\``;
      const { llm, writes } = fakeLlm(PLAN, ANALYSIS, fenced, {
        // quote 가 펜스를 푼 초안의 첫 줄이라 펜스가 남아 있으면 찾지 못한다
        review: { issues: [{ ...ISSUE, quote: '# 지연 로딩' }] },
        revised: REVISED,
      });
      const { markdown } = await run(llm);

      assert.equal(writes.length, 2);
      assert.ok(markdown.includes('이미지를 늦게 불러오도록 바꿨다'));
      assert.ok(!markdown.includes('```markdown'));
    });

    it('검토를 건너뛰어도 바깥 펜스로 감싼 초안은 펜스를 벗겨 조립한다', async () => {
      const fenced = `\`\`\`markdown\n${MARKDOWN}\n\`\`\``;
      const { llm } = fakeLlm(PLAN, ANALYSIS, fenced);
      const { markdown } = await run(llm, { remainingTimeMs: () => REVIEW_MIN_REMAINING_MS - 1 });

      assert.ok(markdown.startsWith('# 지연 로딩'));
      assert.ok(!markdown.includes('```markdown'));
      assert.ok(markdown.includes('```ts'));
    });

    it('고쳐 쓴 초안이 조립에서 막히면 원래 초안을 조립하고 reportError 를 부른다', async () => {
      // 고쳐 쓴 초안은 자리표시자·제목 검사(checkRevision)는 통과하지만 본문이 없어 조립이 invalid_result 로 던진다
      const original = '# 지연 로딩\n\n지연 로딩을 넣었다';
      const { llm } = fakeLlm(PLAN, ANALYSIS, original, {
        review: { issues: [ISSUE] },
        revised: '# 지연 로딩',
      });
      const { markdown, errors } = await run(llm);

      assert.ok(markdown.includes('지연 로딩을 넣었다'));
      assert.equal(errors.length, 1);
      assert.equal((errors[0] as GenerationFailure).code, 'invalid_result');
    });

    it('GenerationFailure 가 아닌 오류(사용량 기록 실패 등)는 삼키지 않고 던진다', async () => {
      const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN);
      const pipeline = createClaudePipeline({
        llm,
        fetchLinks: async () => LINKS,
        remainingTimeMs: () => 300_000,
      });
      let calls = 0;
      const input: PipelineInput = {
        context: CONTEXT,
        commits: COMMITS,
        // 기획·분석·작성 호출은 통과하고 검토 호출(네 번째)에서 던진다
        onUsage: async () => {
          calls += 1;
          if (calls === 4) throw new Error('db down');
        },
      };
      const prepared = await pipeline.prepare(input);
      const analyzed = await pipeline.analyze(input, await pipeline.classify(input, prepared));
      const written = await pipeline.write(input, analyzed);

      await assert.rejects(pipeline.review(input, written), /db down/);
    });

    it('검토·고쳐 쓰기 사용량도 onUsage 로 보고한다', async () => {
      const { llm } = fakeLlm(PLAN, ANALYSIS, MARKDOWN, {
        review: { issues: [ISSUE] },
        revised: REVISED,
      });
      const { usage } = await run(llm);

      assert.equal(usage.length, 5);
    });
  });
});
