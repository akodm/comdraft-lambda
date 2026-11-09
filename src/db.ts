import postgres from 'postgres';

export type Database = postgres.Sql;

/**
 * Supabase Postgres 연결 (Lambda 실행 환경이 재사용되면 연결도 재사용)
 * - Supavisor 트랜잭션 풀러는 prepared statement 를 지원하지 않으므로 prepare: false
 * - 한 번에 하나의 작업만 처리하므로 연결은 1개
 */
let client: Database | null = null;

export const getDatabase = (databaseUrl: string): Database => {
  client ??= postgres(databaseUrl, {
    max: 1,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  return client;
};
