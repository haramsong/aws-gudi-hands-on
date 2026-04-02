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

# 필수 파라미터 입력
read -p "GitHub Webhook Secret: " WEBHOOK_SECRET
read -p "GitHub App ID: " APP_ID
read -p "GitHub Installation ID: " INSTALLATION_ID

# 선택 파라미터
read -p "Slack Webhook URL (없으면 Enter): " SLACK_URL

echo ""
echo "🚀 빌드 및 배포 시작..."

sam build

# samconfig.toml이 없으면 --guided로 첫 배포
if [ ! -f samconfig.toml ]; then
  echo "📋 첫 배포입니다. 스택 설정을 진행합니다..."
  sam deploy --guided \
    --parameter-overrides \
      "GitHubWebhookSecret=$WEBHOOK_SECRET" \
      "GitHubAppId=$APP_ID" \
      "GitHubInstallationId=$INSTALLATION_ID" \
      "GitHubPrivateKey=$(cat "$PEM_FILE")" \
      "SlackWebhookUrl=$SLACK_URL"
else
  sam deploy \
    --parameter-overrides \
      "GitHubWebhookSecret=$WEBHOOK_SECRET" \
      "GitHubAppId=$APP_ID" \
      "GitHubInstallationId=$INSTALLATION_ID" \
      "GitHubPrivateKey=$(cat "$PEM_FILE")" \
      "SlackWebhookUrl=$SLACK_URL"
fi
