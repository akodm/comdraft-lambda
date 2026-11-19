import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Database } from './db.ts';
import { buildDefaultRows, defaultsVersion } from './prompts/editable.ts';
import { publishPromptDefaults } from './prompt-defaults.ts';

// 실행된 문장과 값을 기록하고, 첫 select 에는 정해 둔 행을 돌려주는 가짜 sql
const fakeSql = (existing: { version: string; count: number }[]) => {
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });

      return text.includes('select') ? existing : [];
    },
    { array: (value: unknown[]) => value },
  );
  const sql = { begin: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as Database;

  return { sql, calls };
};

describe('publishPromptDefaults', () => {
  const rows = buildDefaultRows();
  const version = defaultsVersion(rows);

  it('version 과 행 수가 모두 같으면 건드리지 않음', async () => {
    const { sql, calls } = fakeSql([{ version, count: rows.length }]);

    assert.equal(await publishPromptDefaults(sql), 'unchanged');
    assert.equal(calls.length, 1);
  });

  it('다른 version 이 섞여 있으면 전체 교체', async () => {
    const { sql, calls } = fakeSql([
      { version, count: rows.length - 1 },
      { version: 'old', count: 1 },
    ]);

    assert.equal(await publishPromptDefaults(sql), 'published');
    assert.ok(calls.some((call) => call.text.includes('delete from comdraft.ai_prompt_default')));
    assert.equal(calls.filter((call) => call.text.includes('insert into')).length, rows.length);
  });

  it('행 수가 다르면 교체, 비어 있어도 교체', async () => {
    assert.equal(await publishPromptDefaults(fakeSql([{ version, count: 1 }]).sql), 'published');
    assert.equal(await publishPromptDefaults(fakeSql([]).sql), 'published');
  });
});
