# comdraft-lambda

comdraft 의 AI 초안 작성 Lambda 와 AWS 인프라(Terraform).

```text
Next.js 서버 (comdraft) ──SigV4──▶ API Gateway (REST, IAM 인증, 스로틀)
                                      │ 비동기(Event) 호출, 즉시 202
                                      ▼
                               Lambda (Node.js 22, 이 저장소)
                                 커밋 상세 1회 조회 → 구분 → 분석 → 작성
                                 단계마다 DB(draft_prompt) 갱신 + Supabase Realtime Broadcast
```

- 사용하지 않는 AWS 서비스: Step Functions, VPC, CloudWatch Logs(실행 역할에 `logs:*` 권한 없음), SQS/SNS
- 요청/신호 형식과 오류 코드는 comdraft 의 `lib/generation/contract.ts` 와 `src/contract.ts` 를 같게 유지
- 커밋 코드는 메모리에서만 사용하고 DB, 로그 어디에도 저장하지 않음
- 지금 단계(`src/pipeline.ts`)는 LLM 연동 전 임시 구현: 커밋 정보로 Markdown 뼈대만 만듦

## 개발

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build   # dist/index.mjs
```

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

## 주의

- `infra/terraform.tfstate` 에 Lambda 환경 변수(DB 주소 등)가 평문으로 저장됨: 공유하거나 커밋하지 않음
- Lambda 실행 시간 제한(`lambda_timeout_seconds`)과 비동기 대기 시간(`lambda_max_event_age_seconds`)은
  comdraft 의 `GENERATION_LAMBDA_TIMEOUT_MS`, `GENERATION_QUEUED_TIMEOUT_MS` 와 맞출 것
- 신규 계정은 Lambda 계정 동시성 한도가 10 이라 예약 동시성을 걸 수 없음: 한도 상향 전까지 `lambda_reserved_concurrency = -1`
