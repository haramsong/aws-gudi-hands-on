# 🤖 GitHub PR AI Review Bot

PR이 올라오거나 PR 코멘트에 `/review`를 입력하면, Amazon Bedrock(Nova Pro)이 자동으로 코드 리뷰를 달아주는 서버리스 봇입니다.

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
    ├── Bedrock Nova Pro 코드 리뷰
    ├── PR에 리뷰 코멘트 게시
    └── GitHub Check 완료 (success / failure)
```

## 사용 기술

| 서비스                         | 용도                     |
| ------------------------------ | ------------------------ |
| AWS Lambda (Node.js 22, arm64) | Dispatcher / Worker 함수 |
| Amazon API Gateway (HTTP API)  | GitHub Webhook 수신      |
| Amazon Bedrock (Nova Pro)      | AI 코드 리뷰 생성        |
| GitHub Checks API              | PR에 리뷰 상태 표시      |

## 사전 준비

### 1. GitHub App 생성

1. GitHub 접속 → 우측 상단 프로필 → **Settings**
2. 왼쪽 하단 **Developer settings** → **GitHub Apps** → **New GitHub App**
3. 아래 항목을 입력합니다:

| 항목           | 값                                   |
| -------------- | ------------------------------------ |
| App name       | `pr-review-bot` (원하는 이름)        |
| Homepage URL   | `https://github.com` (아무 URL)      |
| Webhook URL    | `https://example.com` (배포 후 수정) |
| Webhook secret | 임의의 문자열 입력 (메모해두세요)    |

4. **Permissions** 섹션에서 아래 권한을 설정합니다:

| 권한          | 레벨           |
| ------------- | -------------- |
| Pull requests | `Read & Write` |
| Checks        | `Read & Write` |
| Issues        | `Read-only`    |
| Contents      | `Read-only`    |

5. **Subscribe to events** 섹션에서 **Pull request**, **Issue comment** 체크
6. **Where can this GitHub App be installed?** → `Only on this account` 선택
7. **Create GitHub App** 클릭

### 2. GitHub App 설정값 확인

App 생성 후 아래 3가지 값을 확인합니다. 배포 시 파라미터로 사용됩니다.

#### App ID

- App 설정 페이지 상단 **About** 섹션에서 확인
- 예: `123456`

#### Private Key (.pem)

1. App 설정 페이지 → **Generate a private key** 클릭 → `.pem` 파일 다운로드
2. 다운로드한 `.pem` 파일을 프로젝트 루트에 복사합니다 (배포 스크립트가 자동으로 읽습니다)

> 💡 CloudShell 사용 시: 상단 메뉴 **Actions** → **Upload file** → `.pem` 파일 선택 후 프로젝트 루트로 이동
>
> ⚠️ `.pem` 파일은 `.gitignore`에 포함되어 있어 Git에 커밋되지 않습니다.

#### Installation ID

1. App 설정 페이지 → 왼쪽 메뉴 **Install App** → 리뷰할 Repository 선택 → **Install**
2. 설치 후 URL에서 확인 (예: `https://github.com/settings/installations/12345678` → `12345678`)

### 3. Bedrock 모델 활성화

최신 Bedrock 정책에서는 모델을 처음 호출할 때 자동으로 활성화됩니다. 배포 전에 한 번 호출해서 활성화해주세요.

1. AWS 콘솔 → **Amazon Bedrock** → 왼쪽 메뉴 **Model catalog**
2. **Nova Pro** 검색 → 선택
3. **Open in playground** 클릭 → 아무 메시지 입력 → **Run** 클릭
4. 응답이 정상적으로 오면 활성화 완료

> ⚠️ 처음 사용 시 이용 약관 동의(use case details 제출)가 필요할 수 있습니다. 화면 안내에 따라 진행하세요.

> ⚠️ **Anthropic Claude 모델을 사용하려면** 계정당 1회 use case details 제출이 필요합니다. Bedrock 콘솔 → Model catalog에서 Claude 모델을 선택하면 FTU(First Time Use) 폼이 표시됩니다. 제출하면 즉시 접근 가능하며, AWS Organization 내 다른 계정에도 상속됩니다.
>
> 콘솔 대신 CLI로도 제출할 수 있습니다 (CloudShell에서 실행):
>
> ```bash
> # use case details를 base64로 인코딩하여 제출
> aws bedrock put-use-case-for-model-access \
>   --form-data $(echo -n '{"companyName":"My Company","companyWebsite":"https://example.com","intendedUsers":"0","industryOption":"Technology","otherIndustryOption":"","useCases":"AI code review"}' | base64)
> ```
>
> 자세한 내용은 [Access Amazon Bedrock foundation models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) 문서를 참고하세요.

### 4. AWS CloudShell 접속

1. AWS 콘솔 상단 검색바 옆 **CloudShell** 아이콘 (터미널 모양) 클릭
2. 터미널이 열리면 준비 완료 (AWS CLI, SAM CLI, git, Node.js 모두 설치되어 있음)

## 배포

```bash
# 1. 레포 클론
git clone https://github.com/haramsong/aws-gudi-hands-on.git
cd aws-gudi-hands-on

# 2. .pem 파일을 프로젝트 루트에 복사

# 3. 배포 스크립트 실행
./deploy.sh
```

`deploy.sh`는 아래 순서로 동작합니다:

1. 프로젝트 루트의 `.pem` 파일을 자동으로 찾아 base64 인코딩
2. 필수 파라미터를 대화형으로 입력받음 (재배포 시 이전 값을 기본값으로 표시)
3. `sam build` → `sam deploy` 실행 (첫 배포 시 `--guided`로 스택 설정)
4. SSM Parameter Store에 Private Key를 자동 저장 (`sam delete` 시 같이 삭제)

대화형으로 입력하는 파라미터:

| 파라미터                | 설명                                                  |
| ----------------------- | ----------------------------------------------------- |
| `GitHubWebhookSecret`   | GitHub App에서 설정한 Webhook secret                  |
| `GitHubAppId`           | GitHub App 설정 페이지 상단 About의 App ID            |
| `GitHubInstallationId`  | App 설치 후 URL의 Installation ID                     |
| `SlackWebhookUrl`       | Slack Incoming Webhook URL (선택, 비워두면 알림 없음) |

아래 파라미터는 기본값이 있어 별도 입력 없이 배포됩니다:

| 파라미터            | 기본값                        | 설명                        |
| ------------------- | ----------------------------- | --------------------------- |
| `BedrockModelId`    | `apac.amazon.nova-pro-v1:0`   | Bedrock 모델 ID             |
| `BedrockMaxTokens`  | `4096`                        | Bedrock 최대 출력 토큰 수   |

### 모델별 Max Output Tokens 참고

| 모델                 | Model ID                                           | Max Output Tokens | 비고                   |
| -------------------- | -------------------------------------------------- | ----------------- | ---------------------- |
| Nova Micro           | `apac.amazon.nova-micro-v1:0`                      | 5,000             | 텍스트 전용, 가장 빠름 |
| Nova Lite            | `apac.amazon.nova-lite-v1:0`                       | 5,000             | 멀티모달, 저비용       |
| **Nova Pro**         | `apac.amazon.nova-pro-v1:0`                        | **5,000**         | **기본값**             |
| Claude 3.5 Sonnet v2 | `apac.anthropic.claude-3-5-sonnet-20241022-v2:0`   | 8,192             | 안정적, 검증된 모델    |
| Claude 3.7 Sonnet    | `apac.anthropic.claude-3-7-sonnet-20250219-v1:0`   | 8,192             | extended thinking 지원 |
| Claude Sonnet 4      | `apac.anthropic.claude-sonnet-4-20250514-v1:0`     | 16,384            | 코딩 우수              |
| Claude Haiku 4.5     | `global.anthropic.claude-haiku-4-5-20251001-v1:0`  | 8,192             | 빠른 응답, 저비용      |
| Claude Sonnet 4.5    | `global.anthropic.claude-sonnet-4-5-20250929-v1:0` | 16,384            | 최신, 고품질 리뷰      |
| Claude Opus 4.5      | `global.anthropic.claude-opus-4-5-20251101-v1:0`   | 32,000            | 최고 성능, 고비용      |

> `apac.` 접두사는 APAC 리전 내에서만 라우팅됩니다. `global.` 접두사는 전 세계 리전으로 라우팅되어 처리량이 높지만, 데이터가 다른 대륙으로 전송될 수 있습니다.
>
> ⚠️ `BedrockMaxTokens`는 모델의 Max Output Tokens를 초과하지 않도록 설정하세요. 기본값 `4096`은 모든 모델에서 안전합니다.

배포 완료 후 출력되는 `WebhookUrl`을 GitHub App의 Webhook URL에 입력합니다.

## 프로젝트 구조

```
├── template.yaml          # SAM 템플릿
├── deploy.sh              # 배포 스크립트 (대화형 파라미터 입력)
├── dispatcher/
│   ├── package.json
│   └── index.mjs          # Webhook 수신 → 서명 검증 → Worker 호출
└── worker/
    ├── package.json
    └── index.mjs          # Diff 조회 → Bedrock 리뷰 → PR 코멘트
```

## 동작 흐름

1. PR 생성(`opened`) 또는 PR 코멘트에 `/review` 입력 시 GitHub이 Webhook 전송
2. **Dispatcher**: HMAC-SHA256 서명 검증 → 대상 이벤트만 필터링 → Worker를 비동기 호출
3. **Worker**:
   - GitHub Check를 `in_progress`로 생성
   - octokit으로 PR diff 조회
   - diff를 파싱하여 각 줄에 라인 번호 접두사를 붙인 annotated diff 생성
   - Bedrock에 annotated diff를 보내 코드 리뷰 생성 (오타 검출 최우선)
   - 리뷰 결과에 따라 PR 상태 결정:
     - 🐛 버그 또는 🔒 보안 이슈 → `Request Changes`
     - 그 외 코멘트만 → `Comment`
     - 이슈 없음 → `Approve`
   - GitHub Check를 `success` 또는 `failure`로 완료

### 리뷰 카테고리

| 이모지 | 카테고리 | 설명 |
| ------ | -------- | ---- |
| 🐛 | 버그 | 오타, 런타임 에러, 컴파일 에러, 잘못된 값 |
| 🔒 | 보안 | 보안 취약점 |
| ⚡ | 성능 | 성능 개선 |
| 🧹 | 코드 스타일 | 포맷팅, 네이밍 컨벤션, 가독성 |
| 💡 | 제안 | 개선 제안 |
| ✅ | 좋은 코드 | 잘 작성된 코드 |

## 대용량 PR 리뷰 시 주의사항

현재 구조는 파일 단위로 Bedrock에 리뷰를 요청합니다. diff가 큰 파일의 경우 Bedrock 응답이 `BedrockMaxTokens`에서 잘릴 수 있으며, 이 경우 해당 파일의 리뷰 코멘트가 **통째로 누락**됩니다.

CloudWatch 로그에 아래 메시지가 보이면 토큰 부족입니다:

```
[WARN] src/app.ts — 응답이 max_tokens(4096)에서 잘렸습니다.
```

### 해결 방법

1. **`BedrockMaxTokens` 값 올리기** — 가장 간단합니다. 모델별 Max Output Tokens 범위 내에서 올려주세요.

2. **파일별 diff를 hunk 단위로 분할** — diff가 긴 파일을 hunk(변경 블록) 단위로 쪼개서 여러 번 호출하면 입력/출력 모두 짧아집니다. `worker/index.mjs`의 `handler`에서 파일별 호출 부분을 아래처럼 변경합니다:

```javascript
// 변경 전: 파일 단위로 한 번 호출
const reviews = await reviewFile(file.path, fileDiff.slice(0, 10000));

// 변경 후: hunk 단위로 분할 호출
const hunks = fileDiff.split(/(?=^@@\s)/m).filter((h) => h.startsWith("@@"));
const reviews = [];
for (const hunk of hunks) {
  const hunkReviews = await reviewFile(file.path, hunk.slice(0, 10000));
  reviews.push(...hunkReviews);
}
```

> 💡 hunk 분할 시 Bedrock 호출 횟수가 늘어나므로 비용과 Lambda 실행 시간이 증가합니다. 일반적인 PR(수백 줄 이내)에서는 기본 설정으로 충분합니다.

## 리소스 정리

```bash
sam delete
```

> SSM Parameter Store의 Private Key도 SAM 스택에 포함되어 있어 함께 삭제됩니다.

## 예상 비용

> 월 100건의 PR 리뷰 기준으로 산출했습니다. (PR당 평균 diff 약 5,000자 가정)

| 서비스                     | 프리 티어                                    | 예상 사용량                             | 예상 비용             |
| -------------------------- | -------------------------------------------- | --------------------------------------- | --------------------- |
| **Lambda**                 | 월 100만 건 요청 + 400,000 GB-초 (상시 무료) | Dispatcher 100건 + Worker 100건 = 200건 | **$0** (프리 티어 내) |
| **API Gateway (HTTP API)** | 월 100만 건 (12개월 무료)                    | 100건                                   | **$0** (프리 티어 내) |
| **Bedrock (Nova Pro)**     | 프리 티어 없음                               | Input: ~50만 토큰, Output: ~10만 토큰   | **~$0.11**            |

### Bedrock 비용 상세

- Nova Pro 기준: Input $0.80 / 1M 토큰, Output $3.20 / 1M 토큰
- PR 1건당: Input ~5,000 토큰 × $0.0000008 = $0.004
- PR 1건당: Output ~1,000 토큰 × $0.0000032 = $0.0032
- **PR 1건당 약 $0.007, 월 100건 기준 약 $0.70**

### 요약

Bedrock을 제외한 모든 서비스는 프리 티어 범위 안에서 무료로 사용 가능합니다. 실질적인 비용은 Bedrock 호출 비용만 발생하며, 핸즈온 수준의 테스트(수~수십 건)라면 **$0.5 미만**으로 예상됩니다.

> 💡 정확한 비용 산출은 [AWS Pricing Calculator](https://calculator.aws)를 참고하세요.
