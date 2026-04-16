#!/bin/bash
set -euo pipefail

# .pem 파일 찾기
PEM_FILE=$(ls *.pem 2>/dev/null | head -1)

if [ -z "$PEM_FILE" ]; then
  echo "❌ .pem 파일을 프로젝트 루트에 넣어주세요"
  exit 1
fi

echo "🔑 사용할 .pem 파일: $PEM_FILE"
echo ""

# samconfig.toml에서 이전 파라미터 값 읽기
get_prev() {
  local key=$1
  if [ -f samconfig.toml ]; then
    # 형식: Key=\"Value\"
    sed -n 's/.*'"${key}"'=\\"\([^"]*\)\\.*/\1/p' samconfig.toml | head -1
  fi
}

# 이전 값이 있으면 기본값으로 표시
read_with_default() {
  local prompt=$1
  local default=$2
  if [ -n "$default" ]; then
    read -p "${prompt} [${default}]: " value
    echo "${value:-$default}"
  else
    read -p "${prompt}: " value
    echo "$value"
  fi
}

# 파라미터 입력 (이전 값 기본값으로 표시)
WEBHOOK_SECRET=$(read_with_default "GitHub Webhook Secret" "$(get_prev GitHubWebhookSecret)")
APP_ID=$(read_with_default "GitHub App ID" "$(get_prev GitHubAppId)")
INSTALLATION_ID=$(read_with_default "GitHub Installation ID" "$(get_prev GitHubInstallationId)")
SLACK_URL=$(read_with_default "Slack Webhook URL (없으면 Enter)" "$(get_prev SlackWebhookUrl)")

echo ""
echo "🚀 빌드 및 배포 시작..."

# .pem 내용을 base64 인코딩 (줄바꿈 제거)
PRIVATE_KEY_B64=$(base64 < "$PEM_FILE" | tr -d '\n')

sam build

OVERRIDES="GitHubWebhookSecret=$WEBHOOK_SECRET GitHubAppId=$APP_ID GitHubInstallationId=$INSTALLATION_ID GitHubPrivateKey=$PRIVATE_KEY_B64"
if [ -n "$SLACK_URL" ]; then
  OVERRIDES="$OVERRIDES SlackWebhookUrl=$SLACK_URL"
fi

# samconfig.toml이 없으면 스택 설정도 입력받기
if [ ! -f samconfig.toml ]; then
  echo "📋 첫 배포입니다. 스택 설정을 진행합니다..."
  read -p "Stack Name [pr-review-bot]: " STACK_NAME
  STACK_NAME=${STACK_NAME:-pr-review-bot}
  read -p "AWS Region [ap-northeast-2]: " REGION
  REGION=${REGION:-ap-northeast-2}

  sam deploy \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --resolve-s3 \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --parameter-overrides $OVERRIDES

  # samconfig.toml 생성 (재배포 시 사용)
  PARAM_LINE="GitHubWebhookSecret=\\\"$WEBHOOK_SECRET\\\" GitHubAppId=\\\"$APP_ID\\\" GitHubInstallationId=\\\"$INSTALLATION_ID\\\""
  if [ -n "$SLACK_URL" ]; then
    PARAM_LINE="$PARAM_LINE SlackWebhookUrl=\\\"$SLACK_URL\\\""
  fi
  cat > samconfig.toml <<EOF
version = 0.1

[default.deploy.parameters]
stack_name = "$STACK_NAME"
resolve_s3 = true
s3_prefix = "$STACK_NAME"
confirm_changeset = true
capabilities = "CAPABILITY_IAM"
region = "$REGION"
parameter_overrides = "$PARAM_LINE"
image_repositories = []
EOF
  echo "📝 samconfig.toml 생성 완료 (다음 배포부터 이전 값이 기본값으로 표시됩니다)"
else
  sam deploy \
    --parameter-overrides $OVERRIDES
fi
