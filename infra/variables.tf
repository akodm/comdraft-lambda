variable "aws_region" {
  description = "AWS 리전 (Supabase 와 같은 서울)"
  type        = string
  default     = "ap-northeast-2"
}

variable "aws_profile" {
  description = "Terraform 이 사용할 AWS CLI 프로필 이름 (~/.aws/credentials)"
  type        = string
}

variable "name" {
  description = "리소스 이름 접두사"
  type        = string
  default     = "comdraft-generation"
}

variable "database_url" {
  description = "Supabase Supavisor 트랜잭션 풀러(6543) 주소, comdraft 계정"
  type        = string
  sensitive   = true
}

variable "supabase_url" {
  description = "Supabase 프로젝트 URL (Realtime Broadcast 전송용)"
  type        = string
}

variable "supabase_publishable_key" {
  description = "Supabase 공개 키 (Broadcast 신호 전송용)"
  type        = string
}

variable "anthropic_api_key" {
  description = "Anthropic API 키 (초안 생성 모델 호출용)"
  type        = string
  sensitive   = true
}

variable "lambda_timeout_seconds" {
  description = "Lambda 실행 시간 제한 (Next.js lib/generation/contract.ts 의 GENERATION_LAMBDA_TIMEOUT_MS 와 맞출 것)"
  type        = number
  default     = 300
}

variable "lambda_memory_mb" {
  description = "Lambda 메모리"
  type        = number
  default     = 256
}

variable "lambda_reserved_concurrency" {
  description = "동시에 실행할 수 있는 최대 작업 수 (-1: 제한 없음). 계정 동시성 한도가 10 인 신규 계정에서는 예약할 수 없으므로 -1 유지"
  type        = number
  default     = -1
}

variable "lambda_max_event_age_seconds" {
  description = "비동기 호출이 대기열에서 기다릴 수 있는 최대 시간 (Next.js 의 GENERATION_QUEUED_TIMEOUT_MS 와 맞출 것)"
  type        = number
  default     = 60
}

variable "api_throttle_rate_limit" {
  description = "API Gateway 전체 초당 요청 수"
  type        = number
  default     = 1
}

variable "api_throttle_burst_limit" {
  description = "API Gateway 순간 허용 요청 수"
  type        = number
  default     = 5
}
