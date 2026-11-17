import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseGenerationRequest } from '../contract.ts';
import {
  CODE_INPUT_LIMITS,
  countLines,
  matchesCodeInputMeta,
  normalizeCode,
  parseCodeInputs,
} from './code-input.ts';

const lines = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join('\n');

describe('countLines', () => {
  it('CRLF·CR 줄바꿈을 LF 로 맞춘 뒤 끝 줄바꿈 하나를 빼고 센다', () => {
    assert.equal(countLines('a\r\nb\r\n'), 2);
    assert.equal(countLines('a\rb'), 2);
    assert.equal(countLines('a'), 1);
    assert.equal(countLines('a\n\n'), 2);
  });

  it('normalizeCode 는 줄바꿈만 LF 로 바꾼다', () => {
    assert.equal(normalizeCode('a\r\n\tb\rc'), 'a\n\tb\nc');
  });
});

describe('parseCodeInputs', () => {
  it('생략이나 빈 배열은 빈 목록, 배열이 아니면 null', () => {
    assert.deepEqual(parseCodeInputs(undefined), []);
    assert.deepEqual(parseCodeInputs([]), []);
    assert.equal(parseCodeInputs('x'), null);
  });

  it('이름과 정규화한 코드만 남긴다', () => {
    assert.deepEqual(parseCodeInputs([{ name: 'a.ts', code: 'a\r\nb', extra: 1 }]), [
      { name: 'a.ts', code: 'a\nb' },
    ]);
  });

  it('제한을 넘거나 형식이 다르면 null', () => {
    const ok = { name: 'a.ts', code: 'x' };
    const rejected: unknown[] = [
      Array.from({ length: CODE_INPUT_LIMITS.maxInputs + 1 }, () => ok),
      [{ name: 'a.ts', code: lines(CODE_INPUT_LIMITS.maxLines + 1) }],
      [{ name: 'a.ts', code: 'x'.repeat(CODE_INPUT_LIMITS.maxChars + 1) }],
      [
        { name: 'a', code: 'x'.repeat(20_000) },
        { name: 'b', code: 'x'.repeat(20_000) },
        { name: 'c', code: 'x'.repeat(10_001) },
      ],
      [{ name: 'a.ts', code: ' \n\t ' }],
      [{ name: '', code: 'x' }],
      [{ name: 'a'.repeat(CODE_INPUT_LIMITS.maxNameChars + 1), code: 'x' }],
      [{ name: 'a\nb', code: 'x' }],
      [{ name: 'a\u0000b', code: 'x' }],
      [{ name: 'a.ts', code: 1 }],
      [null],
    ];
    for (const value of rejected) assert.equal(parseCodeInputs(value), null);
  });

  it('줄 수와 글자 수 상한 그대로는 통과한다', () => {
    const atLines = lines(CODE_INPUT_LIMITS.maxLines);
    assert.equal(parseCodeInputs([{ name: 'a', code: atLines }])?.length, 1);
    assert.equal(parseCodeInputs([{ name: 'a', code: 'x'.repeat(CODE_INPUT_LIMITS.maxChars) }])?.length, 1);
  });
});

describe('matchesCodeInputMeta', () => {
  it('순서·이름·줄 수가 모두 같을 때만 true', () => {
    const inputs = [
      { name: 'a.ts', code: 'a\nb' },
      { name: '코드 2', code: 'c' },
    ];
    assert.equal(
      matchesCodeInputMeta(inputs, [
        { name: 'a.ts', lines: 2 },
        { name: '코드 2', lines: 1 },
      ]),
      true,
    );
    assert.equal(matchesCodeInputMeta([], []), true);
    assert.equal(matchesCodeInputMeta(inputs, [{ name: 'a.ts', lines: 2 }]), false);
    assert.equal(
      matchesCodeInputMeta(inputs, [
        { name: '코드 2', lines: 1 },
        { name: 'a.ts', lines: 2 },
      ]),
      false,
    );
    assert.equal(
      matchesCodeInputMeta(inputs, [
        { name: 'a.ts', lines: 3 },
        { name: '코드 2', lines: 1 },
      ]),
      false,
    );
  });
});

describe('parseGenerationRequest 의 codeInputs', () => {
  it('없으면 빈 배열, 잘못되면 요청 전체를 거부한다', () => {
    assert.deepEqual(parseGenerationRequest({ jobId: 'j', githubToken: 't' }), {
      jobId: 'j',
      githubToken: 't',
      codeInputs: [],
    });
    assert.deepEqual(
      parseGenerationRequest({ jobId: 'j', githubToken: 't', codeInputs: [{ name: 'a', code: 'x' }] })
        ?.codeInputs,
      [{ name: 'a', code: 'x' }],
    );
    assert.equal(parseGenerationRequest({ jobId: 'j', githubToken: 't', codeInputs: [{ name: '' }] }), null);
  });
});
