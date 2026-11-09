output "generation_api_url" {
  description = "Next.js 의 작성 요청 주소 (GENERATION_API_URL)"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/generations"
}

output "invoker_user_name" {
  description = "Next.js 서버용 IAM 사용자 (액세스 키는 직접 발급)"
  value       = aws_iam_user.invoker.name
}

output "lambda_function_name" {
  value = aws_lambda_function.generation.function_name
}
