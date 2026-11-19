import type { JobLocale } from '../jobs.ts';
import { en } from './en.ts';
import { ko } from './ko.ts';
import { applyOverrides, type PromptOverride } from './overrides.ts';
import type { PromptPack } from './types.ts';

export type {
  AnalyzePromptInput,
  FillPromptInput,
  PlanPromptInput,
  PromptPack,
  ReviewPromptInput,
  RevisePromptInput,
  WritePromptInput,
} from './types.ts';

// 로케일을 추가할 때는 여기에 한 줄을 더한다 (파이프라인 코드는 바꾸지 않는다)
const PACKS: Record<JobLocale, PromptPack> = { ko, en };

// 수정본이 없으면 기본 묶음 그대로, 있으면 검사를 통과한 것만 얹은 새 묶음
export const getPromptPack = (locale: JobLocale, overrides: readonly PromptOverride[] = []): PromptPack =>
  overrides.length === 0 ? PACKS[locale] : applyOverrides(PACKS[locale], overrides).pack;
