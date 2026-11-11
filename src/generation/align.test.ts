import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { alignDraftToPlan } from './align.ts';

const plan = (...sections: [number, string][]) => sections.map(([level, heading]) => ({ level, heading }));

describe('alignDraftToPlan', () => {
  it('계획의 제목 수준으로 맞춘다 (모델이 모두 h2 로 납작하게 쓴 경우)', () => {
    const draft = '# 제목\n\n## 하나\n\n본문\n\n## 둘\n\n본문\n\n## 셋\n\n본문';
    const result = alignDraftToPlan(draft, plan([2, '하나'], [3, '둘'], [4, '셋']));
    assert.equal(result, '# 제목\n\n## 하나\n\n본문\n\n### 둘\n\n본문\n\n#### 셋\n\n본문');
  });

  it('계획에 없고 자리표시자도 없는 절은 지운다', () => {
    const draft = '# 제목\n\n## 하나\n\n{{code:S1}}\n\n## 둘\n\n본문 {{link:L1}}\n\n## 참고 링크 주의\n\n메타 문장';
    const result = alignDraftToPlan(draft, plan([2, '하나'], [2, '둘']));
    assert.equal(result, '# 제목\n\n## 하나\n\n{{code:S1}}\n\n## 둘\n\n본문 {{link:L1}}');
  });

  it('계획에 없어도 코드나 빈칸 자리표시자가 있는 절은 남긴다', () => {
    const draft = '# 제목\n\n## 하나\n\n본문\n\n## 덤\n\n{{ask:U1}}';
    assert.equal(alignDraftToPlan(draft, plan([2, '하나'])), draft);
  });

  it('제목만 바꿔 쓴 계획 절은 수가 넘치지 않으니 지우지 않고 수준만 맞춘다', () => {
    const draft = '# 제목\n\n## 하나\n\n본문\n\n## 다르게 쓴 둘\n\n본문';
    const result = alignDraftToPlan(draft, plan([2, '하나'], [3, '둘']));
    assert.equal(result, '# 제목\n\n## 하나\n\n본문\n\n### 다르게 쓴 둘\n\n본문');
  });

  it('제목 띄어쓰기·문장부호 차이는 같은 제목으로 본다', () => {
    const draft = '# 제목\n\n## sharp로 WebP 변환하기\n\n본문\n\n## 정리!\n\n본문';
    const result = alignDraftToPlan(draft, plan([2, 'sharp 로 webp 변환하기'], [3, '정리']));
    assert.equal(result, '# 제목\n\n## sharp로 WebP 변환하기\n\n본문\n\n### 정리!\n\n본문');
  });

  it('제목 수가 계획과 다르면 수준을 건드리지 않는다', () => {
    const draft = '# 제목\n\n## 바뀐 이름\n\n{{ask:U1}}\n\n## 둘\n\n본문';
    assert.equal(alignDraftToPlan(draft, plan([2, '하나'], [3, '둘'], [3, '셋'])), draft);
  });

  it('계획 수준이 앞 제목보다 두 단계 깊으면 한 단계까지만 깊게 둔다', () => {
    const draft = '# 제목\n\n## 하나\n\n본문\n\n## 둘\n\n본문';
    assert.equal(alignDraftToPlan(draft, plan([2, '하나'], [4, '둘'])), '# 제목\n\n## 하나\n\n본문\n\n### 둘\n\n본문');
  });
});
