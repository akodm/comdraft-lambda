import { createHash } from 'node:crypto';
import { FILL_TARGET_MARKER } from '../contract.ts';
import type { JobLocale } from '../jobs.ts';
import { getPromptPack } from './index.ts';
import {
  LENGTHS,
  POST_TYPES,
  REQUIRED_BLOCKS,
  TONES,
  type Length,
  type PostType,
  type PromptPack,
  type RequiredBlock,
  type Tone,
} from './types.ts';

const STAGES = ['plan', 'analyze', 'write', 'review', 'revise', 'fill'] as const;
type Stage = (typeof STAGES)[number];

// 어드민에서 고칠 수 있는 프롬프트 키. 열거 값을 더하면 목록에도 자동으로 나타난다.
export type EditablePromptKey =
  | `${Stage}.system`
  | `tone.${Tone}`
  | `postType.${PostType}`
  | `length.${Length}.target`
  | `requiredBlocks.${RequiredBlock}`;

export const EDITABLE_PROMPT_KEYS: readonly EditablePromptKey[] = [
  ...STAGES.map((stage) => `${stage}.system` as const),
  ...TONES.map((tone) => `tone.${tone}` as const),
  ...POST_TYPES.map((type) => `postType.${type}` as const),
  ...LENGTHS.map((length) => `length.${length}.target` as const),
  ...REQUIRED_BLOCKS.map((block) => `requiredBlocks.${block}` as const),
];

// 키를 (묶음 안의 위치, 하위 키) 로 풀어 읽기·쓰기가 같은 길을 쓰게 한다
const parseKey = (key: EditablePromptKey): string[] => {
  const parts = key.split('.');

  // length.<l>.target 은 가운데가 값 이름
  return parts[0] === 'length' ? [parts[0], parts[1], parts[2]] : parts;
};

export const readEditableText = (pack: PromptPack, key: EditablePromptKey): string => {
  const [group, name, field] = parseKey(key);

  switch (group) {
    case 'tone':
      return pack.tone[name as Tone];
    case 'postType':
      return pack.postType[name as PostType];
    case 'requiredBlocks':
      return pack.requiredBlocks[name as RequiredBlock];
    case 'length':
      return pack.length[name as Length][field as 'target'];
    default:
      return pack[group as Stage].system;
  }
};

// 원본을 바꾸지 않고 해당 키만 바꾼 새 묶음을 돌려줌
export const writeEditableText = (
  pack: PromptPack,
  key: EditablePromptKey,
  text: string,
): PromptPack => {
  const [group, name] = parseKey(key);

  switch (group) {
    case 'tone':
      return { ...pack, tone: { ...pack.tone, [name]: text } };
    case 'postType':
      return { ...pack, postType: { ...pack.postType, [name]: text } };
    case 'requiredBlocks':
      return { ...pack, requiredBlocks: { ...pack.requiredBlocks, [name]: text } };
    case 'length':
      return {
        ...pack,
        length: { ...pack.length, [name]: { ...pack.length[name as Length], target: text } },
      };
    default:
      return { ...pack, [group]: { ...pack[group as Stage], system: text } };
  }
};

/**
 * 수정본이 반드시 지켜야 하는 문자열: 기본 문장에 들어 있는 규칙 마커, 빈칸 대상 자리, 태그 (`<draft>`, `</draft>` 형태 그대로)
 * 어드민이 수정본을 저장하기 전에 이것이 모두 남아 있는지 검사한다.
 */
export const requiredMarkersOf = (text: string, pack: PromptPack): string[] => {
  const found = new Set<string>();

  for (const marker of [
    pack.dataRuleMarker,
    pack.voiceRuleMarker,
    pack.readerRuleMarker,
    pack.clarifyRuleMarker,
    FILL_TARGET_MARKER,
  ]) {
    if (text.includes(marker)) {
      found.add(marker);
    }
  }

  for (const match of text.matchAll(/<\/?([a-z][a-z_-]*)>/g)) {
    found.add(match[0]);
  }

  return [...found].sort();
};

export interface DefaultRow {
  locale: JobLocale;
  key: EditablePromptKey;
  content: string;
  requiredMarkers: string[];
}

const DEFAULT_LOCALES: readonly JobLocale[] = ['ko', 'en'];

export const buildDefaultRows = (): DefaultRow[] =>
  DEFAULT_LOCALES.flatMap((locale) => {
    const pack = getPromptPack(locale);

    return EDITABLE_PROMPT_KEYS.map((key) => {
      const content = readEditableText(pack, key);

      return { locale, key, content, requiredMarkers: requiredMarkersOf(content, pack) };
    });
  });

// 행을 (locale, key) 로 정렬한 JSON 의 SHA-256. 기본값이 바뀌었는지 비교하는 데 씀
export const defaultsVersion = (rows: readonly DefaultRow[]): string => {
  const tuples = [...rows]
    .sort((a, b) => (a.locale === b.locale ? 0 : a.locale < b.locale ? -1 : 1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((row) => [row.locale, row.key, row.content, row.requiredMarkers]);

  return createHash('sha256').update(JSON.stringify(tuples)).digest('hex');
};
