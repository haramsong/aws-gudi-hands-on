# 🤖 GitHub PR AI Review Bot

PR이 올라오거나 새 커밋이 push되면, Amazon Bedrock(Claude)이 자동으로 코드 리뷰를 달아주는 서버리스 봇입니다.

## 아키텍처

```
GitHub Webhook
    │
    ▼
API Gateway (HTTP API)
    │
    ▼
Dispatcher Lambda ──── 서명 검증 + 이벤트 필터링
    │
    │ (비동기 호출)
    ▼
Worker Lambda
    ├── GitHub Check 생성 (in_progress)
    ├── PR diff 조회 (octokit)
    ├── Bedrock Claude 코드 리뷰
    ├── PR에 리뷰 코멘트 게시
    ├── GitHub Check 완료 (success / failure)
    └── DynamoDB 중복 방지
```

## 사용 기술

| 서비스 | 용도 |
|--------|------|
| AWS Lambda (Node.js 22, arm64) | Dispatcher / Worker 함수 |
| Amazon API Gateway (HTTP API) | GitHub Webhook 수신 |
| Amazon Bedrock (Claude Haiku 4.5) | AI 코드 리뷰 생성 |
| Amazon DynamoDB | 동일 커밋 중복 리뷰 방지 (TTL 24h) |
| GitHub Checks API | PR에 리뷰 상태 표시 |

## 사전 준비

### 1. GitHub App 생성

1. GitHub 접속 → 우측 상단 프로필 → **Settings**
2. 왼쪽 하단 **Developer settings** → **GitHub Apps** → **New GitHub App**
3. 아래 항목을 입력합니다:

| 항목 | 값 |
|------|-----|
| App name | `pr-review-bot` (원하는 이름) |
| Homepage URL | `https://github.com` (아무 URL) |
| Webhook URL | `https://example.com` (배포 후 수정) |
| Webhook secret | 임의의 문자열 입력 (메모해두세요) |

4. **Permissions** 섹션에서 아래 권한을 설정합니다:

| 권한 | 레벨 |
|------|------|
| Pull requests | `Read & Write` |
| Checks | `Read & Write` |
| Contents | `Read-only` |

5. **Subscribe to events** 섹션에서 **Pull request** 체크
6. **Where can this GitHub App be installed?** → `Only on this account` 선택
7. **Create GitHub App** 클릭

### 2. GitHub App 설정값 확인

App 생성 후 아래 3가지 값을 확인합니다. 배포 시 파라미터로 사용됩니다.

#### App ID

- App 설정 페이지 상단 **About** 섹션에서 확인
- 예: `123456`

#### Private Key (.pem)

1. App 설정 페이지 → **Generate a private key** 클릭 → `.pem` 파일 다운로드
2. AWS SSM Parameter Store에 저장합니다:

```bash
# CloudShell에서 실행 (.pem 파일을 업로드한 후)
aws ssm put-parameter \
  --name "/pr-review-bot/github-private-key" \
  --type String \
  --value "$(cat your-app.pem)"
```

> 💡 CloudShell에 파일 업로드: 상단 메뉴 **Actions** → **Upload file** → `.pem` 파일 선택
>
> ⚠️ 프로덕션 환경에서는 `--type SecureString`을 사용하세요. SecureString은 KMS로 암호화되어 더 안전하지만, KMS 호출 비용이 발생합니다.

#### Installation ID

1. App 설정 페이지 → 왼쪽 메뉴 **Install App** → 리뷰할 Repository 선택 → **Install**
2. 설치 후 URL에서 확인 (예: `https://github.com/settings/installations/12345678` → `12345678`)

### 3. AWS CloudShell 접속

1. AWS 콘솔 상단 검색바 옆 **CloudShell** 아이콘 (터미널 모양) 클릭
2. 터미널이 열리면 준비 완료 (AWS CLI, SAM CLI, git, Node.js 모두 설치되어 있음)

## 배포

```bash
# 1. 레포 클론
git clone <repo-url>
cd aws-gudi-hands-on

# 2. 빌드
sam build

# 3. 배포 (첫 배포 시)
sam deploy --guided
```

`--guided` 실행 시 아래 파라미터를 입력합니다:

| 파라미터 | 설명 |
|----------|------|
| `GitHubWebhookSecret` | GitHub App에서 설정한 Webhook secret |
| `GitHubAppId` | GitHub App 설정 페이지 상단 About의 App ID |
| `GitHubPrivateKeyParam` | SSM 파라미터 이름 (기본: `/pr-review-bot/github-private-key`) |
| `GitHubInstallationId` | App 설치 후 URL의 Installation ID |

배포 완료 후 출력되는 `WebhookUrl`을 GitHub App의 Webhook URL에 입력합니다.

## 프로젝트 구조

```
├── template.yaml          # SAM 템플릿
├── dispatcher/
│   ├── package.json
│   └── index.mjs          # Webhook 수신 → 서명 검증 → Worker 호출
└── worker/
    ├── package.json
    └── index.mjs          # Diff 조회 → Bedrock 리뷰 → PR 코멘트
```

## 동작 흐름

1. PR 생성(`opened`) 또는 새 커밋 push(`synchronize`) 시 GitHub이 Webhook 전송
2. **Dispatcher**: HMAC-SHA256 서명 검증 → 대상 이벤트만 필터링 → Worker를 비동기 호출
3. **Worker**:
   - DynamoDB로 동일 SHA 중복 체크
   - GitHub Check를 `in_progress`로 생성
   - octokit으로 PR diff 조회
   - Bedrock Claude에 diff를 보내 코드 리뷰 생성
   - PR에 리뷰 코멘트 게시
   - GitHub Check를 `success` 또는 `failure`로 완료

## 리소스 정리

```bash
sam delete
```

## 예상 비용

> 월 100건의 PR 리뷰 기준으로 산출했습니다. (PR당 평균 diff 약 5,000자 가정)

| 서비스 | 프리 티어 | 예상 사용량 | 예상 비용 |
|--------|-----------|-------------|-----------|
| **Lambda** | 월 100만 건 요청 + 400,000 GB-초 (상시 무료) | Dispatcher 100건 + Worker 100건 = 200건 | **$0** (프리 티어 내) |
| **API Gateway (HTTP API)** | 월 100만 건 (12개월 무료) | 100건 | **$0** (프리 티어 내) |
| **DynamoDB** | 25GB 스토리지 + 25 WCU/RCU (상시 무료) | 100건 읽기/쓰기 | **$0** (프리 티어 내) |
| **Bedrock (Claude Haiku 4.5)** | 프리 티어 없음 | Input: ~50만 토큰, Output: ~10만 토큰 | **~$1.00** |

### Bedrock 비용 상세

- Claude Haiku 4.5 기준: Input $1.00 / 1M 토큰, Output $5.00 / 1M 토큰
- PR 1건당: Input ~5,000 토큰 (diff + 프롬프트) × $0.000001 = $0.005
- PR 1건당: Output ~1,000 토큰 (리뷰 결과) × $0.000005 = $0.005
- **PR 1건당 약 $0.01, 월 100건 기준 약 $1.00**

### 요약

Bedrock을 제외한 모든 서비스는 프리 티어 범위 안에서 무료로 사용 가능합니다. 실질적인 비용은 Bedrock 호출 비용만 발생하며, 핸즈온 수준의 테스트(수~수십 건)라면 **$0.5 미만**으로 예상됩니다.

> 💡 정확한 비용 산출은 [AWS Pricing Calculator](https://calculator.aws)를 참고하세요.
