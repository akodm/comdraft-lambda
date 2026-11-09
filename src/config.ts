/**
 * Lambda 환경 변수 (Terraform 의 aws_lambda_function.environment 로 주입)
 */

export interface LambdaConfig {
  // Supabase Supavisor 트랜잭션 풀러(6543) 주소, comdraft 계정
  databaseUrl: string;
  supabaseUrl: string;
  // Realtime Broadcast 전송용 공개 키 (신호만 보내므로 공개 키로 충분)
  supabasePublishableKey: string;
}

const requireEnv = (env: NodeJS.ProcessEnv, key: string) => {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} 환경 변수가 설정되지 않았습니다.`);
  }

  return value;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): LambdaConfig => ({
  databaseUrl: requireEnv(env, 'DATABASE_URL'),
  supabaseUrl: requireEnv(env, 'SUPABASE_URL'),
  supabasePublishableKey: requireEnv(env, 'SUPABASE_PUBLISHABLE_KEY'),
});
