import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Analysis, Plan } from './schemas.ts';
import { parseStoredAnalysis, toStoredAnalysis } from './stored-analysis.ts';

const plan: Plan = {
  title: '이미지 지연 로딩',
  takeaway: '보이는 이미지만 불러온다',
  sections: [
    { level: 2, heading: '느린 첫 화면', purpose: '계기', hunks: [], links: [] },
    { level: 2, heading: '보이는 이미지만 불러오기', purpose: '해결', hunks: ['C1.F1.H1'], links: ['L1'] },
  ],
  excludedCommits: [{ id: 'C2', reason: '오타' }],
  linkRoles: [],
  clarify: null,
};

const analysis: Analysis = {
  facts: [
    { id: 'K1', section: 1, text: 'IntersectionObserver 로 화면 진입을 감지한다', evidence: ['C1.F1.H1', 'C1'] },
    { id: 'K2', section: 1, text: '뷰포트 밖 이미지는 나중에 불러온다', evidence: ['L1'] },
  ],
  code: [
    { id: 'S1', section: 1, from: 'C1.F1.H1', startLine: 1, endLine: 3, mode: 'after', point: '관찰을 시작하는 부분' },
  ],
  unknowns: [{ id: 'U1', section: 0, kind: 'motivation', ask: '첫 화면이 얼마나 느렸나요?' }],
  tags: ['react'],
};

describe('toStoredAnalysis', () => {
  it('절마다 제목, 사실 문장, 코드 point, 빈칸 질문만 남긴다', () => {
    assert.deepEqual(toStoredAnalysis(plan, analysis), {
      version: 1,
      sections: [
        { heading: '느린 첫 화면', facts: [], points: [], questions: ['첫 화면이 얼마나 느렸나요?'] },
        {
          heading: '보이는 이미지만 불러오기',
          facts: ['IntersectionObserver 로 화면 진입을 감지한다', '뷰포트 밖 이미지는 나중에 불러온다'],
          points: ['관찰을 시작하는 부분'],
          questions: [],
        },
      ],
    });
  });

  it('근거 번호, 코드 위치, 커밋 정보는 저장하지 않는다', () => {
    const text = JSON.stringify(toStoredAnalysis(plan, analysis));

    for (const leaked of ['C1.F1.H1', '"C1"', 'C2', 'startLine', 'evidence', '오타']) {
      assert.ok(!text.includes(leaked), leaked);
    }
  });
});

describe('parseStoredAnalysis', () => {
  it('저장한 형태를 그대로 읽고, 문자열(JSON)로 와도 읽는다', () => {
    const stored = toStoredAnalysis(plan, analysis);

    assert.deepEqual(parseStoredAnalysis(stored), stored);
    assert.deepEqual(parseStoredAnalysis(JSON.stringify(stored)), stored);
  });

  it('없거나 형식이 다르면 null', () => {
    for (const value of [null, undefined, '', '{', 42, {}, { version: 2, sections: [] }, { version: 1, sections: [{ heading: 1 }] }]) {
      assert.equal(parseStoredAnalysis(value), null, JSON.stringify(value));
    }
  });
});
