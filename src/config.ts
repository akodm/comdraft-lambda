/**
 * Lambda 환경 변수 (Terraform 의 aws_lambda_function.environment 로 주입)
 */

// Anthropic Workload Identity Federation 설정 (비밀값이 아닌 ID, Claude Console 의 Workload identity 에서 확인)
export interface FederationConfig {
  federationRuleId: string;
  organizationId: string;
  serviceAccountId: string;
  // 규칙이 워크스페이스 하나만 허용하면 생략 가능
  workspaceId?: string;
}

export interface LambdaConfig {
  // Supabase Supavisor 트랜잭션 풀러(6543) 주소, comdraft 계정
  databaseUrl: string;
  supabaseUrl: string;
  // Realtime Broadcast 전송용 공개 키 (신호만 보내므로 공개 키로 충분)
  supabasePublishableKey: string;
  // Anthropic 인증 (API 키 대신 Lambda 실행 역할로 연동)
  federation: FederationConfig;
  // STS GetWebIdentityToken 을 호출할 리전 (Lambda 가 AWS_REGION 을 자동 설정)
  awsRegion: string;
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
  federation: {
    federationRuleId: requireEnv(env, 'ANTHROPIC_FEDERATION_RULE_ID'),
    organizationId: requireEnv(env, 'ANTHROPIC_ORGANIZATION_ID'),
    serviceAccountId: requireEnv(env, 'ANTHROPIC_SERVICE_ACCOUNT_ID'),
    workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined,
  },
  awsRegion: requireEnv(env, 'AWS_REGION'),
});
