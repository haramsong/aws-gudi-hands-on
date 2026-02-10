import { Octokit } from "@octokit/rest";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const bedrock = new BedrockRuntimeClient();
const dynamo = new DynamoDBClient();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const TABLE = process.env.DEDUPE_TABLE;
const CHECK_NAME = "AI Code Review";

// GitHub Check 생성 (in_progress 상태)
async function createCheck(owner, repo, headSha) {
  const res = await octokit.rest.checks.create({
    owner, repo, name: CHECK_NAME, head_sha: headSha, status: "in_progress",
  });
  return res.data.id;
}

// GitHub Check 완료 처리
async function completeCheck(owner, repo, checkRunId, conclusion, summary) {
  await octokit.rest.checks.update({
    owner, repo, check_run_id: checkRunId, status: "completed", conclusion,
    output: { title: CHECK_NAME, summary },
  });
}

// 중복 리뷰 방지 (DynamoDB)
async function isDuplicate(key) {
  try {
    await dynamo.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: key }, ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) } },
      ConditionExpression: "attribute_not_exists(pk)",
    }));
    return false;
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return true;
    throw e;
  }
}

// diff를 파일별로 파싱 → [{ path, chunks: [{ startLine, lines }] }]
function parseDiff(diff) {
  const files = [];
  let current = null;

  for (const line of diff.split("\n")) {
    // 새 파일 시작
    if (line.startsWith("diff --git")) {
      current = null;
      continue;
    }
    // 변경된 파일 경로
    if (line.startsWith("+++ b/")) {
      current = { path: line.slice(6), chunks: [] };
      files.push(current);
      continue;
    }
    // 헝크(hunk) 헤더: @@ -old,count +new,count @@
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunkMatch && current) {
      current.chunks.push({ startLine: parseInt(hunkMatch[1]), lines: [] });
      continue;
    }
    // 헝크 내부 라인 수집 (삭제 라인 제외)
    if (current?.chunks.length > 0 && !line.startsWith("-")) {
      current.chunks.at(-1).lines.push(line);
    }
  }
  return files;
}

// 파일별 diff에서 특정 라인의 실제 줄번호 계산
function getLineNumber(chunk, indexInChunk) {
  let lineNum = chunk.startLine;
  for (let i = 0; i < indexInChunk; i++) {
    if (!chunk.lines[i].startsWith("-")) lineNum++;
  }
  return lineNum;
}

// Bedrock에 파일 단위로 리뷰 요청 → JSON 배열 응답
async function reviewFile(filePath, diff) {
  const res = await bedrock.send(new InvokeModelCommand({
    modelId: "anthropic.claude-haiku-4-5-20251001-v1:0",
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      system: `당신은 시니어 코드 리뷰어입니다. 반드시 한국어로 답변하세요.

## 리뷰 규칙
- 버그, 보안 취약점, 성능 문제, 가독성 개선점을 찾아주세요.
- 문제가 없으면 빈 배열 []을 반환하세요.

## 출력 형식
반드시 아래 JSON 배열만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.
[
  {
    "line": 해당_줄번호,
    "body": "이모지 무엇이 문제인지 설명\\n\\n\`\`\`suggestion\\n수정된 코드\\n\`\`\`"
  }
]

## body 작성 규칙
1. 첫 줄: 카테고리 이모지 + 문제점 또는 개선점을 명확히 설명
2. 수정이 필요한 경우: 빈 줄 후 suggestion 블록 추가
3. 단순 코멘트만 필요한 경우: suggestion 블록 생략

카테고리 이모지:
  🐛 버그/오류  🔒 보안 이슈  ⚡ 성능 개선  🧹 코드 스타일  💡 제안  ✅ 좋은 코드

## 예시
{ "line": 10, "body": "🔒 사용자 입력을 검증 없이 쿼리에 직접 사용하고 있어 SQL Injection 위험이 있습니다.\\n\\n\`\`\`suggestion\\nconst result = await db.query('SELECT * FROM users WHERE id = ?', [userId]);\\n\`\`\`" }
{ "line": 25, "body": "🧹 변수명이 모호합니다. 역할을 명확히 드러내는 이름이 좋습니다.\\n\\n\`\`\`suggestion\\nconst maxRetryCount = 3;\\n\`\`\`" }
{ "line": 42, "body": "✅ 에러 핸들링이 잘 되어 있습니다." }

## 주의사항
- "line"은 diff에서 +로 시작하는 변경된 줄의 번호입니다.
- suggestion 블록 안에는 해당 줄을 대체할 코드만 넣으세요.`,
      messages: [{
        role: "user",
        content: `파일: ${filePath}\n\n\`\`\`diff\n${diff}\n\`\`\``,
      }],
    }),
  }));

  const parsed = JSON.parse(new TextDecoder().decode(res.body));
  const { input_tokens, output_tokens } = parsed.usage;
  console.log(`[tokens] ${filePath} — input: ${input_tokens}, output: ${output_tokens}`);

  const text = parsed.content[0].text;
  try {
    // JSON 배열 추출 (앞뒤 텍스트가 있을 수 있으므로)
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch {
    return [];
  }
}

export const handler = async (event) => {
  const { owner, repo, prNumber, headSha } = event;
  const dedupeKey = `${owner}/${repo}#${prNumber}@${headSha}`;

  if (await isDuplicate(dedupeKey)) {
    console.log("Duplicate, skipping:", dedupeKey);
    return { status: "skipped" };
  }

  const checkRunId = await createCheck(owner, repo, headSha);

  try {
    // PR diff 가져오기
    const diffRes = await octokit.rest.pulls.get({
      owner, repo, pull_number: prNumber,
      mediaType: { format: "diff" },
    });

    const files = parseDiff(diffRes.data);
    const comments = [];

    // 파일별로 Bedrock 리뷰 요청
    for (const file of files) {
      // 파일별 diff 텍스트 재구성
      const fileDiff = diffRes.data
        .split("diff --git")
        .find((s) => s.includes(`+++ b/${file.path}`));
      if (!fileDiff) continue;

      const reviews = await reviewFile(file.path, fileDiff.slice(0, 10000));

      for (const r of reviews) {
        if (r.line && r.body) {
          comments.push({ path: file.path, line: r.line, body: r.body });
        }
      }
    }

    // PR에 인라인 리뷰 코멘트 게시
    await octokit.rest.pulls.createReview({
      owner, repo, pull_number: prNumber,
      commit_id: headSha,
      event: comments.length > 0 ? "COMMENT" : "APPROVE",
      body: comments.length > 0
        ? `🤖 **AI Code Review** — ${comments.length}건의 피드백`
        : "🤖 **AI Code Review** — ✅ 코드가 깔끔합니다!",
      comments,
    });

    await completeCheck(owner, repo, checkRunId, "success", `리뷰 완료: ${comments.length}건의 피드백`);
    return { status: "reviewed", comments: comments.length };
  } catch (err) {
    await completeCheck(owner, repo, checkRunId, "failure", `리뷰 중 오류 발생: ${err.message}`);
    throw err;
  }
};
