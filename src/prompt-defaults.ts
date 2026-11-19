import type { Database } from './db.ts';
import { buildDefaultRows, defaultsVersion } from './prompts/editable.ts';

/**
 * 코드의 프롬프트 기본값을 comdraft.ai_prompt_default 에 올린다 (어드민이 키 목록·필수 문자열을 읽는 곳)
 * - 저장된 행이 모두 지금 version 이고 행 수도 같으면 건드리지 않음
 * - 아니면 한 트랜잭션으로 전체 교체
 */
export const publishPromptDefaults = async (sql: Database): Promise<'unchanged' | 'published'> => {
  const rows = buildDefaultRows();
  const version = defaultsVersion(rows);

  return sql.begin(async (tx) => {
    const groups = await tx<{ version: string; count: number }[]>`
      select version, count(*)::int as count
      from comdraft.ai_prompt_default
      group by version
    `;

    const total = groups.reduce((sum, group) => sum + Number(group.count), 0);

    if (
      total === rows.length &&
      groups.every((group) => group.version === version) &&
      (groups.length === 1 || rows.length === 0)
    ) {
      return 'unchanged' as const;
    }

    await tx`delete from comdraft.ai_prompt_default`;

    for (const row of rows) {
      await tx`
        insert into comdraft.ai_prompt_default (locale, key, content, required_markers, version, updated_at)
        values (${row.locale}, ${row.key}, ${row.content}, ${tx.array(row.requiredMarkers)}, ${version}, now())
      `;
    }

    return 'published' as const;
  });
};
