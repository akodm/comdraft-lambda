# 빌드 결과(dist/index.mjs, pnpm build)를 배포 파일로 묶음
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../dist"
  output_path = "${path.module}/build/lambda.zip"
}

# Lambda 실행 역할
# - CloudWatch Logs 를 쓰지 않기 위해 logs:* 권한(AWSLambdaBasicExecutionRole 등)을 붙이지 않음
#   → Lambda 가 로그 그룹/스트림을 만들지 못해 로그가 쌓이지 않음 (로깅은 Sentry 로)
# - VPC 를 쓰지 않으므로 네트워크 관련 권한도 없음
data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  # Terraform 용 IAM 사용자의 권한 범위(role/terraform-lambda-*)에 맞춘 이름
  name               = "terraform-lambda-${var.name}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_lambda_function" "generation" {
  function_name    = var.name
  description      = "comdraft AI 초안 작성 (구분 → 분석 → 작성)"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = var.lambda_timeout_seconds
  memory_size      = var.lambda_memory_mb

  reserved_concurrent_executions = var.lambda_reserved_concurrency

  environment {
    variables = {
      DATABASE_URL             = var.database_url
      SUPABASE_URL             = var.supabase_url
      SUPABASE_PUBLISHABLE_KEY = var.supabase_publishable_key
      ANTHROPIC_API_KEY        = var.anthropic_api_key
    }
  }
}

# 비동기 호출 설정: 실패 시 다시 실행하지 않음 (LLM 비용 중복 방지, 실패는 Lambda 가 DB 에 기록)
resource "aws_lambda_function_event_invoke_config" "generation" {
  function_name                = aws_lambda_function.generation.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = var.lambda_max_event_age_seconds
}

# API Gateway 가 이 Lambda 를 호출할 수 있도록 허용 (POST /generations 만)
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.generation.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.generation.execution_arn}/*/POST/generations"
}
