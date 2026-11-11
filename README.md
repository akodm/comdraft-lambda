# comdraft-lambda

**[comdraft](https://github.com/akodm/comdraft) 의 AI 초안 작성 Lambda 와 AWS 인프라 (Terraform)**

서비스: **[comdraft.vercel.app](https://comdraft.vercel.app)** · 웹 앱: [akodm/comdraft](https://github.com/akodm/comdraft)

comdraft 사용자가 커밋을 고르고 작성 요청을 보내면, 이 Lambda 가 GitHub 에서 커밋 상세를 읽고 Claude 로 기술 블로그 초안을 씁니다. 결과와 진행 상황은 DB 와 Supabase Realtime 으로 comdraft 화면에 전달됩니다.

## 하는 일

```text
Next.js 서버 (comdraft) ──SigV4──▶ API Gateway (REST, IAM 인증, 스로틀)
                                      │ 비동기(Event) 호출, 즉시 202
                                      ▼
                               Lambda (Node.js 22, 이 저장소)
                                 준비 → 예상량 검사 → 기획 → 분석 → 작성 → 조립 (Claude Haiku 5.5)
                                 단계마다 DB(draft_prompt) 갱신 + Supabase Realtime Broadcast
```

1. **준비**: GitHub 에서 커밋 상세와 코드 변경을 가져오고, 비밀 파일은 빼고 비밀값은 가립니다. 참고 링크는 SSRF 방어를 거쳐 직접 가져옵니다.
2. **예상량 검사**: 준비한 입력으로 사용할 토큰을 추정하고, 사용자의 주간 할당량(`quota_plan`)을 넘으면 Claude 를 부르지 않고 거부합니다. 같은 사용자의 동시 요청은 DB 잠금으로 줄 세웁니다.
3. **기획 → 분석 → 작성**: Claude Haiku 5.5(`claude-haiku-5-5`)로 글의 구조를 잡고, 코드 변경을 분석하고, 본문을 씁니다. 호출마다 실제 사용 토큰을 기록합니다.
4. **조립**: 코드, 참고 링크, 빈칸을 모델 출력 대신 원문으로 바꿔 넣고, 모델이 직접 쓴 링크와 HTML 은 무력화합니다.

- 커밋 코드와 참고 링크 본문은 메모리에서만 쓰고 DB, 로그 어디에도 저장하지 않습니다.
- 사용하지 않는 AWS 서비스: Step Functions, VPC, CloudWatch Logs(실행 역할에 `logs:*` 권한 없음), SQS/SNS
- 요청/신호 형식과 오류 코드는 comdraft 의 `lib/generation/contract.ts` 와 이 저장소의 `src/contract.ts` 를 같게 유지합니다.

## 기술 스택

| 영역 | 사용 기술 |
| --- | --- |
| 런타임 | Node.js 22, TypeScript (esbuild 로 단일 번들) |
| AI | Anthropic SDK, Claude Haiku 5.5, Workload Identity Federation (API 키 없음) |
| 데이터 | Supabase Postgres (`postgres`), Supabase Realtime Broadcast |
| 날짜 | dayjs (할당량 주 경계, Asia/Seoul) |
| 인프라 | AWS API Gateway, Lambda, IAM, Terraform |
| 테스트 | `node:test` |

## 폴더 구조

```text
src/handler.ts       Lambda 진입점
src/run-job.ts       작업 한 건 실행 (상태 갱신, 할당량 예약, 실패 처리)
src/pipeline.ts      준비 → 기획 → 분석 → 작성 → 조립
src/generation/      커밋 준비, 링크 수집, 비밀값 처리, 예상량, Claude 호출, 조립
src/prompts/         단계별 프롬프트 (한국어·영어)
src/jobs.ts          작업 저장소 (DB)
src/quota.ts         주간 할당량 규칙
infra/               Terraform (API Gateway, Lambda, IAM)
```

## 개발

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build   # dist/index.mjs 를 만든 뒤 번들을 불러와 보는 smoke 검사(pnpm smoke)까지 실행
```

## 환경 변수

Lambda 환경 변수는 Terraform(`infra/lambda.tf`)이 주입함. 값은 git 제외 파일 `infra/terraform.tfvars` 에만 적음(README, 코드, 로그에 실제 값을 남기지 않음).

| 환경 변수 | Terraform 변수 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | `database_url` (sensitive) | Supabase 트랜잭션 풀러(6543) 주소 |
| `SUPABASE_URL` | `supabase_url` | Realtime Broadcast 전송용 |
| `SUPABASE_PUBLISHABLE_KEY` | `supabase_publishable_key` | Broadcast 신호 전송용 공개 키 |
| `ANTHROPIC_FEDERATION_RULE_ID` | `anthropic_federation_rule_id` | Anthropic 연동 규칙 ID (`fdrl_...`) |
| `ANTHROPIC_ORGANIZATION_ID` | `anthropic_organization_id` | Anthropic 조직 ID |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | `anthropic_service_account_id` | 연동 규칙이 가리키는 서비스 계정 ID (`svac_...`) |
| `ANTHROPIC_WORKSPACE_ID` | `anthropic_workspace_id` | 워크스페이스 ID (규칙이 워크스페이스 하나만 허용하면 빈 값) |

Anthropic 인증은 API 키 없이 **Workload Identity Federation** 을 씀. Lambda 가 실행 역할로 AWS STS `GetWebIdentityToken` 을 호출해 받은 JWT 를 Anthropic 단기 토큰으로 교환함(SDK 가 캐시와 갱신을 처리). 위 값들은 모두 비밀값이 아닌 ID 이고, `ANTHROPIC_API_KEY` 는 쓰지 않음(설정돼 있으면 혼동의 원인이 되므로 넣지 말 것).

### Anthropic 연동 설정 (최초 1회)

1. AWS: IAM > Account settings 에서 **Outbound web identity federation** 을 켜고, 표시되는 **Get Token Issuer URL**(`https://<uuid>.tokens.sts.global.api.aws`)을 복사
2. `terraform apply` 로 실행 역할에 `sts:GetWebIdentityToken` 권한을 붙인 뒤, 출력값 `lambda_role_arn` 확인
3. Claude Console > Settings > Workload identity > **Connect workload** > AWS
   - 발급자(issuer): 1의 Issuer URL, JWKS 는 discovery
   - 규칙(rule): subject 를 `lambda_role_arn` 과 **정확히** 일치(끝에 `*` 없이), audience `https://api.anthropic.com`, scope `workspace:developer`, 토큰 수명 600초
   - 만들어진 `fdrl_...`, `svac_...`, 조직 ID(와 필요하면 워크스페이스 ID)를 `infra/terraform.tfvars` 에 넣고 다시 `terraform apply`

## 배포

1. AWS CLI 프로필 준비 (comdraft 전용 AWS 계정의 IAM 사용자)

   ```bash
   aws configure --profile comdraft-main-iam
   ```

2. 변수 파일 작성: `infra/terraform.tfvars.example` 을 `infra/terraform.tfvars` 로 복사해 값 입력 (git 제외)
3. 빌드 후 적용 (Lambda 코드를 바꿀 때도 같은 순서)

   ```bash
   pnpm build
   cd infra
   terraform init
   terraform plan
   terraform apply
   ```

4. Next.js 서버용 IAM 사용자(`invoker_user_name` 출력값)의 액세스 키를 직접 발급해 comdraft 의 Vercel 환경 변수에 등록
   (상태 파일에 비밀 키가 남지 않도록 Terraform 으로 만들지 않음)

   ```bash
   aws iam create-access-key --user-name comdraft-generation-invoker --profile comdraft-main-iam
   ```

## 배포 순서

comdraft 와 함께 바뀌는 변경은 아래 순서를 지킵니다.

1. comdraft 의 DB 마이그레이션을 로컬과 운영에 적용
2. comdraft(Next.js) 배포: Lambda 가 읽는 작업 기록(예: `draft_prompt.reference_urls`)을 새 코드가 먼저 쓰도록 **Lambda 보다 먼저**
3. `pnpm build` 후 `infra` 에서 `terraform apply` 로 Lambda 배포

## 주의

- 런타임은 `nodejs22.x`: undici 8 이 Node 22.19 이상을 요구하므로, 배포 전에 AWS 의 nodejs22.x 런타임 패치 버전이 22.19 이상인지 확인할 것
- `infra/terraform.tfstate` 에 Lambda 환경 변수(DB 주소 등)가 평문으로 저장됨: 공유하거나 커밋하지 않음 (Anthropic 은 연동 방식이라 키가 남지 않음)
- Terraform IAM 사용자에게 실행 역할의 인라인 정책을 붙일 권한(`iam:PutRolePolicy` 등, `role/terraform-lambda-*` 범위)이 있어야 함
- Lambda 실행 시간 제한(`lambda_timeout_seconds`)과 비동기 대기 시간(`lambda_max_event_age_seconds`)은
  comdraft 의 `GENERATION_LAMBDA_TIMEOUT_MS`, `GENERATION_QUEUED_TIMEOUT_MS` 와 맞출 것
- 신규 계정은 Lambda 계정 동시성 한도가 10 이라 예약 동시성을 걸 수 없음: 한도 상향 전까지 `lambda_reserved_concurrency = -1`
