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

# .pem 내용을 base64 인코딩 (줄바꿈 제거)
PRIVATE_KEY_B64=$(base64 < "$PEM_FILE" | tr -d '\n')

sam build

OVERRIDES="GitHubWebhookSecret=$WEBHOOK_SECRET GitHubAppId=$APP_ID GitHubInstallationId=$INSTALLATION_ID GitHubPrivateKey=$PRIVATE_KEY_B64 SlackWebhookUrl=$SLACK_URL"

# samconfig.toml이 없으면 --guided로 첫 배포
if [ ! -f samconfig.toml ]; then
  echo "📋 첫 배포입니다. 스택 설정을 진행합니다..."
  sam deploy --guided \
    --parameter-overrides $OVERRIDES
else
  sam deploy \
    --parameter-overrides $OVERRIDES
fi
