import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FILL_TARGET_MARKER } from '../contract.ts';
import {
  buildDefaultRows,
  defaultsVersion,
  EDITABLE_PROMPT_KEYS,
  readEditableText,
  requiredMarkersOf,
  writeEditableText,
} from './editable.ts';
import { getPromptPack } from './index.ts';

const LOCALES = ['ko', 'en'] as const;

describe('EDITABLE_PROMPT_KEYS', () => {
  it('정해진 키를 모두 가짐', () => {
    assert.equal(EDITABLE_PROMPT_KEYS.length, 6 + 3 + 3 + 3 + 9);
    for (const key of ['plan.system', 'fill.system', 'tone.plain', 'postType.lecture', 'length.long.target', 'requiredBlocks.h1']) {
      assert.ok((EDITABLE_PROMPT_KEYS as readonly string[]).includes(key), key);
    }
  });
});

describe('readEditableText / writeEditableText', () => {
  it('모든 키가 ko·en 에서 비어 있지 않음', () => {
    for (const locale of LOCALES) {
      const pack = getPromptPack(locale);
      for (const key of EDITABLE_PROMPT_KEYS) {
        assert.notEqual(readEditableText(pack, key), '', `${locale} ${key}`);
      }
    }
  });

  it('write 후 읽으면 바뀐 값이고 원본은 그대로', () => {
    const pack = getPromptPack('ko');
    for (const key of EDITABLE_PROMPT_KEYS) {
      const before = readEditableText(pack, key);
      const next = writeEditableText(pack, key, '바뀐 값');
      assert.equal(readEditableText(next, key), '바뀐 값', key);
      assert.equal(readEditableText(pack, key), before, key);
      assert.notEqual(next, pack);
    }
  });
});

describe('requiredMarkersOf', () => {
  it('fill.system 필수 문자열에 FILL_TARGET_MARKER 가 들어감', () => {
    for (const locale of LOCALES) {
      const pack = getPromptPack(locale);
      const text = readEditableText(pack, 'fill.system');
      assert.ok(requiredMarkersOf(text, pack).includes(FILL_TARGET_MARKER), locale);
    }
  });

  it('문장에 있는 규칙 마커와 태그만 중복 없이 정렬해 돌려줌', () => {
    const pack = getPromptPack('ko');
    const text = `${pack.dataRuleMarker} <draft> x </draft> <draft>`;
    assert.deepEqual(requiredMarkersOf(text, pack), [pack.dataRuleMarker, '</draft>', '<draft>'].sort());
    assert.deepEqual(requiredMarkersOf('아무것도 없음', pack), []);
  });
});

describe('buildDefaultRows / defaultsVersion', () => {
  it('ko·en 의 모든 키 행을 만듦', () => {
    const rows = buildDefaultRows();
    assert.equal(rows.length, EDITABLE_PROMPT_KEYS.length * 2);
    assert.ok(rows.every((row) => row.content !== ''));
  });

  it('같은 기본값이면 같은 version, 내용이 바뀌면 다른 version', () => {
    const rows = buildDefaultRows();
    assert.equal(defaultsVersion(rows), defaultsVersion([...buildDefaultRows()].reverse()));
    assert.match(defaultsVersion(rows), /^[0-9a-f]{64}$/);
    const changed = rows.map((row, i) => (i === 0 ? { ...row, content: `${row.content}!` } : row));
    assert.notEqual(defaultsVersion(changed), defaultsVersion(rows));
  });
});
