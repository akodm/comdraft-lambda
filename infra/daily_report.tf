# comdraft 일일 현황 보고 (GA4·Search Console 요약을 텍스트로 받는 이메일)
# - Next.js 서버(Vercel)의 매일 아침 스케줄이 이 토픽에 발행 → 이메일 구독으로 전달
# - 이메일 구독은 AWS 가 보내는 확인 메일의 링크를 눌러야 활성화됨 (그전에는 발행해도 전달되지 않음)
resource "aws_sns_topic" "daily_report" {
  name = "comdraft-daily-report"
}

resource "aws_sns_topic_subscription" "daily_report_email" {
  topic_arn = aws_sns_topic.daily_report.arn
  protocol  = "email"
  endpoint  = var.daily_report_email
}

# 작성 API 를 호출하는 같은 서버라 기존 invoker 사용자에 발행 권한만 더함 (새 액세스 키 없이 재사용)
data "aws_iam_policy_document" "publish_daily_report" {
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.daily_report.arn]
  }
}

resource "aws_iam_user_policy" "invoker_publish_daily_report" {
  name   = "publish-daily-report"
  user   = aws_iam_user.invoker.name
  policy = data.aws_iam_policy_document.publish_daily_report.json
}
