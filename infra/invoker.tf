# Next.js 서버(Vercel)가 API Gateway 를 호출할 때 쓰는 IAM 사용자
# - POST /generations 호출 권한만 부여 (최소 권한)
# - 액세스 키는 상태 파일에 비밀 키가 남지 않도록 Terraform 밖에서 직접 발급해 Vercel 환경 변수에 등록
resource "aws_iam_user" "invoker" {
  name = "${var.name}-invoker"
}

data "aws_iam_policy_document" "invoke_generation" {
  statement {
    actions = ["execute-api:Invoke"]
    resources = [
      "${aws_api_gateway_rest_api.generation.execution_arn}/${aws_api_gateway_stage.prod.stage_name}/POST/generations",
    ]
  }
}

resource "aws_iam_user_policy" "invoker" {
  name   = "invoke-generation-api"
  user   = aws_iam_user.invoker.name
  policy = data.aws_iam_policy_document.invoke_generation.json
}
