import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FILL_TARGET_MARKER } from '../contract.ts';
import type { JobContext } from '../jobs.ts';
import { readEditableText, requiredMarkersOf } from './editable.ts';
import { getPromptPack } from './index.ts';
import { applyOverrides } from './overrides.ts';

const ko = getPromptPack('ko');

describe('applyOverrides', () => {
  it('수정본이 기본값을 덮어씀', () => {
    const { pack, rejected } = applyOverrides(ko, [{ key: 'tone.plain', content: '짧고 담백하게.' }]);

    assert.equal(pack.tone.plain, '짧고 담백하게.');
    assert.deepEqual(rejected, []);
  });

  it('원본 묶음은 바꾸지 않음', () => {
    const before = ko.tone.plain;
    applyOverrides(ko, [{ key: 'tone.plain', content: '짧고 담백하게.' }]);

    assert.equal(ko.tone.plain, before);
  });

  it('마커를 잃은 system 수정본은 기본값을 씀', () => {
    const { pack, rejected } = applyOverrides(ko, [{ key: 'write.system', content: '아무 규칙 없음' }]);

    assert.equal(pack.write.system, ko.write.system);
    assert.deepEqual(rejected, ['write.system']);
  });

  it('필수 문자열을 모두 지킨 system 수정본은 받아들임', () => {
    const required = requiredMarkersOf(ko.write.system, ko);
    assert.ok(required.length > 0);

    const content = `새 규칙\n${required.join('\n')}`;
    const { pack, rejected } = applyOverrides(ko, [{ key: 'write.system', content }]);

    assert.equal(pack.write.system, content);
    assert.deepEqual(rejected, []);
  });

  it('빈칸 대상 자리를 잃은 fill 수정본은 거절', () => {
    assert.ok(requiredMarkersOf(ko.fill.system, ko).includes(FILL_TARGET_MARKER));

    const { pack, rejected } = applyOverrides(ko, [{ key: 'fill.system', content: '문단만 써라' }]);

    assert.equal(pack.fill.system, ko.fill.system);
    assert.deepEqual(rejected, ['fill.system']);
  });

  it('공백뿐인 수정본은 거절', () => {
    const { pack, rejected } = applyOverrides(ko, [{ key: 'tone.plain', content: '  \n ' }]);

    assert.equal(pack.tone.plain, ko.tone.plain);
    assert.deepEqual(rejected, ['tone.plain']);
  });

  it('모르는 키는 거절도 반영도 하지 않음', () => {
    const { pack, rejected } = applyOverrides(ko, [{ key: 'nope.system', content: '무엇이든' }]);

    assert.deepEqual(pack, ko);
    assert.deepEqual(rejected, []);
  });

  it('여러 키를 함께 반영하고 거절은 키만 모음', () => {
    const { pack, rejected } = applyOverrides(ko, [
      { key: 'length.long.target', content: '약 4,000자' },
      { key: 'review.system', content: '규칙 없음' },
    ]);

    assert.equal(readEditableText(pack, 'length.long.target'), '약 4,000자');
    assert.equal(pack.review.system, ko.review.system);
    assert.deepEqual(rejected, ['review.system']);
  });
});

describe('applyOverrides: 표 수정본이 실제 프롬프트에 들어감', () => {
  const context: JobContext = {
    kind: 'draft', prompt: 'p', tone: 'plain', postType: 'lecture', length: 'long', requiredBlocks: ['h1'],
    locale: 'ko', model: 'haiku', referenceUrls: [], commitShas: [], owner: 'o', repo: 'r',
    clarification: null, clarificationAsked: false, codeInputMeta: [],
  };

  it('문체 수정본이 system 의 옵션 표와 사용자 입력 옵션 줄에 나타남', () => {
    for (const locale of ['ko', 'en'] as const) {
      const base = getPromptPack(locale);
      const { pack } = applyOverrides(base, [{ key: 'tone.plain', content: 'MARK-TONE' }]);

      assert.ok(!base.write.system.includes('MARK-TONE'));
      assert.ok(pack.write.system.includes('- plain: MARK-TONE'), locale);
      assert.ok(pack.plan.system.includes('- plain: MARK-TONE'), locale);
      assert.ok(pack.revise.system.includes('- plain: MARK-TONE'), locale);
      assert.ok(pack.fill.system.includes('- plain: MARK-TONE'), locale);
      assert.ok(pack.plan.user({ context, commits: [], links: [] }).includes('MARK-TONE'), locale);
    }
  });

  it('길이·필수 블록·글 유형 수정본도 옵션 줄에 나타남', () => {
    const { pack } = applyOverrides(ko, [
      { key: 'length.long.target', content: 'MARK-LEN' },
      { key: 'requiredBlocks.h1', content: 'MARK-BLOCK' },
      { key: 'postType.lecture', content: 'MARK-TYPE' },
    ]);
    const user = pack.plan.user({ context, commits: [], links: [] });

    assert.ok(user.includes('MARK-LEN') && user.includes('MARK-BLOCK') && user.includes('MARK-TYPE'));
  });

  it('표를 고쳐도 system 수정본이 기본 문장으로 돌아가지 않음', () => {
    const required = requiredMarkersOf(ko.write.system, ko);
    const content = `새 규칙\n${required.join('\n')}`;
    const { pack } = applyOverrides(ko, [
      { key: 'write.system', content },
      { key: 'tone.plain', content: 'MARK-TONE' },
    ]);

    assert.equal(pack.write.system, content);
    assert.ok(pack.plan.system.includes('- plain: MARK-TONE'));
  });

  it('수정본이 없는 묶음의 문장은 기본값과 같음', () => {
    const rebuilt = ko.rebuild({ tone: ko.tone, postType: ko.postType, length: ko.length, requiredBlocks: ko.requiredBlocks });

    for (const stage of ['plan', 'analyze', 'write', 'review', 'revise', 'fill'] as const) {
      assert.equal(rebuilt[stage].system, ko[stage].system, stage);
    }
  });
});

describe('getPromptPack 수정본', () => {
  it('수정본이 없으면 기본 묶음 그대로', () => {
    assert.equal(getPromptPack('ko'), ko);
    assert.equal(getPromptPack('ko', []), ko);
  });

  it('수정본이 있으면 새 묶음, 다른 로케일 묶음은 그대로', () => {
    const pack = getPromptPack('en', [{ key: 'tone.plain', content: 'Short.' }]);

    assert.equal(pack.tone.plain, 'Short.');
    assert.equal(getPromptPack('en').tone.plain, readEditableText(getPromptPack('en'), 'tone.plain'));
    assert.notEqual(getPromptPack('en').tone.plain, 'Short.');
  });
});
