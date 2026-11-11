// 작성 모델이 쓴 자리표시자 초안을 계획의 절 구성에 맞춘다.
// 자리표시자 초안에는 코드 펜스가 없어서 줄 단위로 읽는다.

interface PlannedHeading {
  level: number;
  heading: string;
}

const HEADING = /^(#{2,6})[ \t]+(.*)$/;
const KEPT_PLACEHOLDER = /\{\{(?:code|ask):[A-Za-z0-9_-]+\}\}/;

// 띄어쓰기·문장부호·대소문자 차이는 같은 제목으로 본다
const normalize = (heading: string): string => heading.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

interface Section {
  start: number;
  end: number;
  text: string;
}

const sectionsOf = (lines: string[]): Section[] => {
  const starts = lines.flatMap((line, index) => (HEADING.test(line) ? [index] : []));
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    return { start, end, text: HEADING.exec(lines[start])![2] };
  });
};

// 계획보다 절이 많을 때, 계획에 없는 제목의 절을 넘친 수만큼 뒤에서부터 지운다 (모델이 덧붙인 안내·메타 절)
// 코드·빈칸 자리표시자가 있는 절은 지우지 않고, 제목만 바꿔 쓴 계획 절은 수가 넘치지 않으니 남는다
const dropUnplanned = (lines: string[], planned: Set<string>, plannedCount: number): string[] => {
  const sections = sectionsOf(lines);
  const excess = sections.length - plannedCount;
  if (excess <= 0) return lines;
  const dropped = sections
    .filter(
      (section) =>
        !planned.has(normalize(section.text)) &&
        !lines.slice(section.start, section.end).some((line) => KEPT_PLACEHOLDER.test(line)),
    )
    .slice(-excess);
  if (dropped.length === 0) return lines;
  const removed = new Set(dropped.flatMap((section) => range(section.start, section.end)));
  return lines.filter((_line, index) => !removed.has(index));
};

const range = (start: number, end: number): number[] => Array.from({ length: end - start }, (_v, i) => start + i);

// 제목 수가 계획과 같을 때만 계획의 수준을 차례로 입힌다 (앞 제목보다 두 단계 이상 깊어지지 않게)
const applyLevels = (lines: string[], plan: PlannedHeading[]): string[] => {
  const count = lines.filter((line) => HEADING.test(line)).length;
  if (count !== plan.length) return lines;
  let index = 0;
  let previous = 1;
  return lines.map((line) => {
    const match = HEADING.exec(line);
    if (!match) return line;
    const level = Math.min(Math.max(2, plan[index].level), previous + 1);
    index += 1;
    previous = level;
    return `${'#'.repeat(level)} ${match[2]}`;
  });
};

const trimTrailingBlank = (lines: string[]): string[] => {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
};

export const alignDraftToPlan = (draft: string, plan: PlannedHeading[]): string => {
  const lines = draft.split('\n');
  const planned = new Set(plan.map((section) => normalize(section.heading)));
  const kept = dropUnplanned(lines, planned, plan.length);
  const aligned = applyLevels(kept, plan);
  return kept === lines && aligned.every((line, i) => line === lines[i])
    ? draft
    : trimTrailingBlank(aligned).join('\n');
};
