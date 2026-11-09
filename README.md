# comdraft-lambda

comdraft 의 AI 초안 작성 Lambda 와 AWS 인프라(Terraform).

```text
Next.js 서버 (comdraft) ──SigV4──▶ API Gateway (REST, IAM 인증, 스로틀)
                                      │ 비동기(Event) 호출, 즉시 202
                                      ▼
                               Lambda (Node.js 22, 이 저장소)
                                 준비 → 기획 → 분석 → 작성 → 조립 (Claude Haiku 5.5)
                                 단계마다 DB(draft_prompt) 갱신 + Supabase Realtime Broadcast
```

- 사용하지 않는 AWS 서비스: Step Functions, VPC, CloudWatch Logs(실행 역할에 `logs:*` 권한 없음), SQS/SNS
- 요청/신호 형식과 오류 코드는 comdraft 의 `lib/generation/contract.ts` 와 `src/contract.ts` 를 같게 유지
- 커밋 코드와 참고 링크 본문은 메모리에서만 사용하고 DB, 로그 어디에도 저장하지 않음
- 작성 단계: 준비(커밋 상세 조회, 참고 링크 수집) → 기획 → 분석 → 작성 → 조립
  - 모델은 Claude Haiku 5.5(`claude-haiku-5-5`)
  - 참고 링크는 Lambda 가 직접 가져오며, SSRF 방어를 적용함

## 개발

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build   # dist/index.mjs
```

## 환경 변수

Lambda 환경 변수는 Terraform(`infra/lambda.tf`)이 주입함. 값은 git 제외 파일 `infra/terraform.tfvars` 에만 적음(README, 코드, 로그에 실제 값을 남기지 않음).

| 환경 변수 | Terraform 변수 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | `database_url` (sensitive) | Supabase 트랜잭션 풀러(6543) 주소 |
| `SUPABASE_URL` | `supabase_url` | Realtime Broadcast 전송용 |
| `SUPABASE_PUBLISHABLE_KEY` | `supabase_publishable_key` | Broadcast 신호 전송용 공개 키 |
| `ANTHROPIC_API_KEY` | `anthropic_api_key` (sensitive) | 초안 생성 모델 호출용 Anthropic API 키 |

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

## 배포 순서 (AI 초안 프롬프트 변경)

의존성 때문에 아래 순서를 지킴.

1. 사용자가 comdraft 마이그레이션 `0011`(`draft_prompt.locale`)을 로컬과 운영에 적용 (0011 적용 전에는 작성 요청 INSERT 가 실패함)
2. comdraft 를 빈칸 노드(`draftBlank`)와 함께 배포: **Lambda 보다 먼저** 배포해야 함. 노드가 없으면 `:::blank` 가 일반 문단으로 보임
3. `infra/terraform.tfvars` 에 `anthropic_api_key` 를 넣고 `pnpm build` 후 `terraform apply` 로 Lambda 배포

## 주의

- 런타임은 `nodejs22.x`: undici 8 이 Node 22.19 이상을 요구하므로, 배포 전에 AWS 의 nodejs22.x 런타임 패치 버전이 22.19 이상인지 확인할 것

- `infra/terraform.tfstate` 에 Lambda 환경 변수(DB 주소 등)가 평문으로 저장됨: 공유하거나 커밋하지 않음
- Lambda 실행 시간 제한(`lambda_timeout_seconds`)과 비동기 대기 시간(`lambda_max_event_age_seconds`)은
  comdraft 의 `GENERATION_LAMBDA_TIMEOUT_MS`, `GENERATION_QUEUED_TIMEOUT_MS` 와 맞출 것
- 신규 계정은 Lambda 계정 동시성 한도가 10 이라 예약 동시성을 걸 수 없음: 한도 상향 전까지 `lambda_reserved_concurrency = -1`
