import {
  EDITABLE_PROMPT_KEYS,
  readEditableText,
  requiredMarkersOf,
  writeEditableText,
  type EditablePromptKey,
} from './editable.ts';
import type { PromptPack } from './types.ts';

export interface PromptOverride {
  key: string;
  content: string;
}

const isEditableKey = (key: string): key is EditablePromptKey =>
  (EDITABLE_PROMPT_KEYS as readonly string[]).includes(key);

/**
 * 어드민 수정본을 기본 묶음에 얹은 새 묶음을 만든다 (원본은 바꾸지 않음)
 * - 모르는 키는 무시
 * - 기본 문장의 필수 문자열(규칙 마커·빈칸 자리·태그)이 하나라도 빠졌거나 공백뿐이면 기본값을 유지하고 키를 rejected 에 모음
 */
export const applyOverrides = (
  pack: PromptPack,
  overrides: readonly PromptOverride[],
): { pack: PromptPack; rejected: string[] } => {
  const rejected: string[] = [];
  const accepted: { key: EditablePromptKey; content: string }[] = [];

  for (const { key, content } of overrides) {
    if (!isEditableKey(key)) {
      continue;
    }

    const required = requiredMarkersOf(readEditableText(pack, key), pack);

    if (!content.trim() || !required.every((text) => content.includes(text))) {
      rejected.push(key);
      continue;
    }

    accepted.push({ key, content });
  }

  // 문체·글 유형·길이·필수 블록 표는 system 과 옵션 줄이 읽어 만들어지므로 표를 고친 뒤 묶음을 다시 만들고,
  // 그 위에 system 수정본을 얹는다 (다시 만들면 system 이 기본 문장으로 돌아가므로 순서가 중요함)
  const isSystem = (key: EditablePromptKey) => key.endsWith('.system');
  const tables = accepted
    .filter(({ key }) => !isSystem(key))
    .reduce((edited, { key, content }) => writeEditableText(edited, key, content), pack);
  const rebuilt =
    tables === pack
      ? pack
      : pack.rebuild({
          tone: tables.tone,
          postType: tables.postType,
          length: tables.length,
          requiredBlocks: tables.requiredBlocks,
        });
  const next = accepted
    .filter(({ key }) => isSystem(key))
    .reduce((edited, { key, content }) => writeEditableText(edited, key, content), rebuilt);

  return { pack: next, rejected };
};
