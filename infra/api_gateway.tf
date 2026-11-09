# REST API (HTTP API 는 Lambda 비동기 호출 헤더를 지정할 수 없음)
resource "aws_api_gateway_rest_api" "generation" {
  name        = "${var.name}-api"
  description = "comdraft AI 초안 작성 요청 (Next.js 서버 → Lambda 비동기 호출)"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_resource" "generations" {
  rest_api_id = aws_api_gateway_rest_api.generation.id
  parent_id   = aws_api_gateway_rest_api.generation.root_resource_id
  path_part   = "generations"
}

# 요청 본문 검증: Lambda 를 깨우기 전에 형식이 틀린 요청을 거절
resource "aws_api_gateway_model" "generation_request" {
  rest_api_id  = aws_api_gateway_rest_api.generation.id
  name         = "GenerationRequest"
  content_type = "application/json"

  schema = jsonencode({
    "$schema"            = "http://json-schema.org/draft-04/schema#"
    type                 = "object"
    required             = ["jobId", "githubToken"]
    additionalProperties = false
    properties = {
      jobId       = { type = "string", minLength = 1, maxLength = 64 }
      githubToken = { type = "string", minLength = 1, maxLength = 512 }
    }
  })
}

resource "aws_api_gateway_request_validator" "body" {
  rest_api_id           = aws_api_gateway_rest_api.generation.id
  name                  = "body"
  validate_request_body = true
}

# POST /generations: IAM 서명(SigV4) 요청만 허용 (Next.js 서버 전용 IAM 사용자)
resource "aws_api_gateway_method" "post" {
  rest_api_id          = aws_api_gateway_rest_api.generation.id
  resource_id          = aws_api_gateway_resource.generations.id
  http_method          = "POST"
  authorization        = "AWS_IAM"
  request_validator_id = aws_api_gateway_request_validator.body.id

  request_models = {
    "application/json" = aws_api_gateway_model.generation_request.name
  }
}

# Lambda 비동기(Event) 호출: 응답을 기다리지 않고 바로 202 반환 (API Gateway 29초 제한 회피)
resource "aws_api_gateway_integration" "lambda" {
  rest_api_id             = aws_api_gateway_rest_api.generation.id
  resource_id             = aws_api_gateway_resource.generations.id
  http_method             = aws_api_gateway_method.post.http_method
  type                    = "AWS"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.generation.invoke_arn
  passthrough_behavior    = "NEVER"

  request_parameters = {
    "integration.request.header.X-Amz-Invocation-Type" = "'Event'"
  }

  # 요청 본문을 그대로 Lambda 이벤트로 전달
  request_templates = {
    "application/json" = "$input.json('$')"
  }
}

resource "aws_api_gateway_method_response" "accepted" {
  rest_api_id = aws_api_gateway_rest_api.generation.id
  resource_id = aws_api_gateway_resource.generations.id
  http_method = aws_api_gateway_method.post.http_method
  status_code = "202"
}

resource "aws_api_gateway_integration_response" "accepted" {
  rest_api_id = aws_api_gateway_rest_api.generation.id
  resource_id = aws_api_gateway_resource.generations.id
  http_method = aws_api_gateway_method.post.http_method
  status_code = aws_api_gateway_method_response.accepted.status_code

  response_templates = {
    "application/json" = jsonencode({ status = "accepted" })
  }

  depends_on = [aws_api_gateway_integration.lambda]
}

resource "aws_api_gateway_deployment" "generation" {
  rest_api_id = aws_api_gateway_rest_api.generation.id

  # 설정이 바뀌면 새로 배포
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.generations,
      aws_api_gateway_model.generation_request,
      aws_api_gateway_request_validator.body,
      aws_api_gateway_method.post,
      aws_api_gateway_integration.lambda,
      aws_api_gateway_method_response.accepted,
      aws_api_gateway_integration_response.accepted,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "prod" {
  rest_api_id   = aws_api_gateway_rest_api.generation.id
  deployment_id = aws_api_gateway_deployment.generation.id
  stage_name    = "prod"
  # 액세스 로그(access_log_settings)를 설정하지 않음 (CloudWatch 미사용)
}

# 전체 요청 제한 + 실행 로그/지표 끔 (CloudWatch 미사용)
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.generation.id
  stage_name  = aws_api_gateway_stage.prod.stage_name
  method_path = "*/*"

  settings {
    throttling_rate_limit  = var.api_throttle_rate_limit
    throttling_burst_limit = var.api_throttle_burst_limit
    logging_level          = "OFF"
    data_trace_enabled     = false
    metrics_enabled        = false
  }
}
