terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.7"
    }
  }

  # 상태 파일은 로컬(infra/terraform.tfstate, git 제외)에 둠
  # S3 원격 상태는 추가 AWS 인프라라 사용하지 않음. 상태 파일에 Lambda 환경 변수가 평문으로 들어가므로 공유 금지
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile

  default_tags {
    tags = {
      Project   = "comdraft"
      ManagedBy = "terraform"
    }
  }
}
