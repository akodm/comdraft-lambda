import type { JobLocale } from '../jobs.ts';
import { en } from './en.ts';
import { ko } from './ko.ts';
import type { PromptPack } from './types.ts';

export type {
  AnalyzePromptInput,
  PlanPromptInput,
  PromptPack,
  WritePromptInput,
} from './types.ts';

// 로케일을 추가할 때는 여기에 한 줄을 더한다 (파이프라인 코드는 바꾸지 않는다)
const PACKS: Record<JobLocale, PromptPack> = { ko, en };

export const getPromptPack = (locale: JobLocale): PromptPack => PACKS[locale];
