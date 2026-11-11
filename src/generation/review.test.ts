import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acceptRevision, validateReview } from './review.ts';

const DRAFT =
  '# 제목\n\n## 설정\n\n`createSafeLookup` 을 추가했다.\n공식   문서대로\n설정했다.\n\n{{code:S1}}\n\n{{ask:U1}}';

describe('validateReview', () => {
  it('초안에 있는 quote 만 남기고 공백 차이는 같은 것으로 본다', () => {
    const issues = validateReview(
      {
        issues: [
          { kind: 'unknown_term', quote: '`createSafeLookup` 을 추가했다.', fix: '역할로 풀어 쓴다' },
          { kind: 'link_context', quote: '공식 문서대로 설정했다.', fix: '문서 링크를 넣는다' },
          { kind: 'voice', quote: '초안에 없는 문장', fix: 'x' },
        ],
      },
      DRAFT,
    );
    assert.deepEqual(
      issues.map((i) => i.kind),
      ['unknown_term', 'link_context'],
    );
  });

  it('모르는 kind, 중복 quote, 자리표시자만 있는 quote, 빈 fix 를 버리고 8개로 자른다', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `문장${i}`);
    const draft = lines.join('\n');
    const issues = validateReview(
      {
        issues: [
          { kind: 'bogus', quote: '문장0', fix: 'x' },
          { kind: 'voice', quote: '문장1', fix: 'x' },
          { kind: 'flow', quote: '문장1', fix: 'y' },
          { kind: 'voice', quote: '{{code:S1}}', fix: 'x' },
          { kind: 'voice', quote: '문장2', fix: '   ' },
          { kind: 'voice', quote: '   ', fix: 'x' },
          ...lines.slice(3).map((quote) => ({ kind: 'flow', quote, fix: 'x' })),
        ],
      },
      `${draft}\n{{code:S1}}`,
    );
    assert.equal(issues.length, 8);
    assert.equal(issues[0].quote, '문장1');
    assert.equal(issues[0].fix, 'x');
    assert.ok(!issues.some((i) => i.quote === '문장0' || i.quote === '문장2'));
  });

  it('모델이 &lt; 를 그대로 베낀 quote 도 되돌려서 찾는다', () => {
    const issues = validateReview(
      { issues: [{ kind: 'unknown_term', quote: '`&lt;source>` 를 쓴다', fix: '풀어 쓴다' }] },
      '# 제목\n\n`<source>` 를 쓴다',
    );
    assert.deepEqual(issues.map((i) => i.quote), ['`<source>` 를 쓴다']);
  });

  it('fix 는 앞뒤 공백을 빼고 150자로 자른다', () => {
    const [issue] = validateReview(
      { issues: [{ kind: 'voice', quote: '설정했다.', fix: `  ${'가'.repeat(200)}  ` }] },
      DRAFT,
    );
    assert.equal(issue.fix.length, 150);
  });
});

describe('acceptRevision', () => {
  const links = new Set(['L1']);
  it('자리표시자를 지키고 링크를 더한 초안을 받아들인다', () => {
    const revised = DRAFT.replace('공식   문서대로', '공식 문서 {{link:L1}} 대로');
    assert.equal(acceptRevision(DRAFT, revised, links), revised);
  });
  it('바깥 코드 펜스를 풀고 받아들인다', () => {
    assert.equal(acceptRevision(DRAFT, '```markdown\n' + DRAFT + '\n```', links), DRAFT);
  });
  it('제목이 없거나, code·ask 를 빠뜨리거나 늘리거나 새로 만들거나, 모르는 링크를 쓰거나, 비면 거절한다', () => {
    for (const revised of [
      DRAFT.replace('# 제목\n\n', ''),
      DRAFT.replace('{{code:S1}}', ''),
      `${DRAFT}\n\n{{code:S1}}`,
      DRAFT.replace('{{ask:U1}}', '{{ask:U2}}'),
      `${DRAFT} {{link:L9}}`,
      '   ',
    ])
      assert.equal(acceptRevision(DRAFT, revised, links), null);
  });
  it('제목을 빠뜨리거나 수준을 바꾸면 거절하고, 제목 글자만 바꾸면 받아들인다', () => {
    assert.equal(acceptRevision(DRAFT, DRAFT.replace('## 설정\n\n', ''), links), null);
    assert.equal(acceptRevision(DRAFT, DRAFT.replace('## 설정', '### 설정'), links), null);
    const reworded = DRAFT.replace('## 설정', '## 설정을 바꾼 이유');
    assert.equal(acceptRevision(DRAFT, reworded, links), reworded);
  });
  it('안쪽 공백이 있는 자리표시자도 같은 것으로 센다', () => {
    const revised = DRAFT.replace('{{code:S1}}', '{{ code : S1 }}');
    assert.equal(acceptRevision(DRAFT, revised, links), revised);
  });
});
