import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const bedrock = new BedrockRuntimeClient();
const ssm = new SSMClient();
const CHECK_NAME = "AI Code Review";

// SSM에서 Private Key를 가져와 캐싱
let cachedPrivateKey;
async function getPrivateKey() {
  if (!cachedPrivateKey) {
    const res = await ssm.send(new GetParameterCommand({
      Name: process.env.GITHUB_PRIVATE_KEY_PARAM,
      WithDecryption: true,
    }));
    cachedPrivateKey = res.Parameter.Value;
  }
  return cachedPrivateKey;
}

// GitHub App 인증 → Installation Access Token 자동 발급
async function createOctokit() {
  const privateKey = await getPrivateKey();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID,
      privateKey,
      installationId: process.env.GITHUB_INSTALLATION_ID,
    },
  });
}

// GitHub Check 생성 (in_progress 상태)
async function createCheck(octokit, owner, repo, headSha) {
  const res = await octokit.rest.checks.create({
    owner, repo, name: CHECK_NAME, head_sha: headSha, status: "in_progress",
  });
  return res.data.id;
}

// GitHub Check 완료 처리
async function completeCheck(octokit, owner, repo, checkRunId, conclusion, summary) {
  await octokit.rest.checks.update({
    owner, repo, check_run_id: checkRunId, status: "completed", conclusion,
    output: { title: CHECK_NAME, summary },
  });
}

// 리뷰 코멘트에서 카테고리별 요약 생성
function buildSummary(comments) {
  if (comments.length === 0) return "🤖 **AI Code Review** — ✅ 코드가 깔끔합니다!";

  const categories = { "🐛": "버그", "🔒": "보안", "⚡": "성능", "🧹": "클린코드", "💡": "제안" };
  const counts = {};
  const critical = []; // 🐛, 🔒만 치명적 이슈로 표시

  for (const c of comments) {
    for (const [emoji, label] of Object.entries(categories)) {
      if (c.body.includes(emoji)) {
        counts[emoji] = (counts[emoji] || 0) + 1;
        if ((emoji === "🐛" || emoji === "🔒") && critical.length < 3) {
          // body 첫 줄에서 요약 추출
          const firstLine = c.body.split("\n")[0].slice(0, 80);
          critical.push(`- \`${c.path}\`: ${firstLine}`);
        }
        break;
      }
    }
  }

  let body = `🤖 **AI Code Review** — ${comments.length}건의 피드백\n\n`;
  body += "| 카테고리 | 건수 |\n|----------|------|\n";
  for (const [emoji, label] of Object.entries(categories)) {
    if (counts[emoji]) body += `| ${emoji} ${label} | ${counts[emoji]} |\n`;
  }

  if (critical.length > 0) {
    body += `\n⚠️ **주요 이슈**\n${critical.join("\n")}`;
  }

  return body;
}

// diff를 파일별로 파싱 → [{ path, rows: [{ oldLine, newLine, type, content }] }]
// type: "context" | "add" | "delete"
function parseDiff(diff) {
  const files = [];
  let current = null;
  let oldLine = 0, newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = null;
      continue;
    }
    if (line.startsWith("+++ b/")) {
      current = { path: line.slice(6), rows: [] };
      files.push(current);
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
    if (hunkMatch && current) {
      oldLine = parseInt(hunkMatch[1]);
      newLine = parseInt(hunkMatch[2]);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("-")) {
      current.rows.push({ oldLine, newLine: null, type: "delete", content: line.slice(1) });
      oldLine++;
    } else if (line.startsWith("+")) {
      current.rows.push({ oldLine: null, newLine, type: "add", content: line.slice(1) });
      newLine++;
    } else if (line.startsWith(" ")) {
      current.rows.push({ oldLine, newLine, type: "context", content: line.slice(1) });
      oldLine++;
      newLine++;
    }
  }
  return files;
}

// diff rows를 LLM용 annotated 형식으로 변환
// 각 줄에 [L{line}] 또는 [R{line}] 접두사를 붙여 LLM이 라인 번호를 직접 읽도록 함
function buildAnnotatedDiff(rows) {
  return rows.map((r) => {
    if (r.type === "delete") return `[L${r.oldLine}] -${r.content}`;
    if (r.type === "add") return `[R${r.newLine}] +${r.content}`;
    return `[L${r.oldLine}|R${r.newLine}]  ${r.content}`;
  }).join("\n");
}

// Bedrock에 파일 단위로 리뷰 요청 → JSON 배열 응답
async function reviewFile(filePath, annotatedDiff) {
  const res = await bedrock.send(new ConverseCommand({
    modelId: process.env.BEDROCK_MODEL_ID,
    system: [{
      text: `당신은 시니어 코드 리뷰어입니다. 반드시 한국어로 답변하세요.

## 리뷰 규칙
- 최우선: 변수명, 함수명, 타입명, CSS 클래스명의 오타(typo)를 반드시 찾아주세요. 오타는 런타임 에러를 유발합니다.
- 버그, 보안 취약점, 성능 문제, 가독성 개선점을 찾아주세요.
- 추가된 줄(+)뿐만 아니라 삭제된 줄(-)과의 차이도 비교하여 의도치 않은 변경을 찾아주세요.
- 문제가 없으면 빈 배열 []을 반환하세요.

## 입력 형식
diff의 각 줄에는 라인 번호가 접두사로 붙어 있습니다:
- [L숫자] -코드 → 삭제된 줄 (LEFT side, 원본 파일의 라인 번호)
- [R숫자] +코드 → 추가된 줄 (RIGHT side, 변경 파일의 라인 번호)
- [L숫자|R숫자]  코드 → 컨텍스트 줄 (양쪽 라인 번호)

## 출력 형식
반드시 아래 JSON 배열만 출력하세요. 다른 텍스트는 절대 포함하지 마세요.
[
  {
    "line": 접두사에_표시된_라인번호,
    "side": "RIGHT" 또는 "LEFT",
    "body": "이모지 설명\\n\\n\`\`\`suggestion\\n수정된 코드\\n\`\`\`"
  }
]

## line과 side 규칙
- 추가된 줄(+)에 코멘트: line = [R숫자]의 숫자, side = "RIGHT"
- 삭제된 줄(-)에 코멘트: line = [L숫자]의 숫자, side = "LEFT"
- 컨텍스트 줄에 코멘트: line = [R숫자]의 숫자, side = "RIGHT"
- 접두사에 있는 숫자를 그대로 사용하세요. 직접 계산하지 마세요.

## 멀티라인 코멘트 (선택)
여러 줄에 걸친 이슈는 start_line과 start_side를 추가하세요:
{
  "start_line": 시작_줄번호,
  "start_side": "RIGHT" 또는 "LEFT",
  "line": 끝_줄번호,
  "side": "RIGHT" 또는 "LEFT",
  "body": "..."
}

## body 작성 규칙
1. 첫 줄: 카테고리 이모지 + 문제점 설명
2. 수정 필요 시: 빈 줄 후 suggestion 블록 추가
3. suggestion 블록은 RIGHT side 줄에만 사용 가능

카테고리 이모지:
  🐛 버그/오류  🔒 보안 이슈  ⚡ 성능 개선  🧹 코드 스타일  💡 제안  ✅ 좋은 코드

## 주의사항
- suggestion 블록 안에는 해당 줄을 대체할 코드만 넣으세요.
- 삭제 줄(LEFT)에는 suggestion 블록을 사용하지 마세요.` }],
    messages: [{
      role: "user",
      content: [{ text: `파일: ${filePath}\n\n${annotatedDiff}` }],
    }],
    inferenceConfig: { maxTokens: parseInt(process.env.BEDROCK_MAX_TOKENS) || 4096 },
  }));

  const { inputTokens, outputTokens } = res.usage;
  const stopReason = res.stopReason;
  console.log(`[tokens] ${filePath} — input: ${inputTokens}, output: ${outputTokens}, stopReason: ${stopReason}`);

  if (stopReason === "max_tokens") {
    console.warn(`[WARN] ${filePath} — 응답이 max_tokens(${process.env.BEDROCK_MAX_TOKENS || 4096})에서 잘렸습니다. 리뷰 코멘트가 누락될 수 있습니다.`);
  }

  const text = res.output.message.content[0].text;
  try {
    // JSON 배열 추출 (앞뒤 텍스트가 있을 수 있으므로)
    const match = text.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch {
    if (stopReason === "max_tokens") {
      console.error(`[ERROR] ${filePath} — JSON 파싱 실패 (응답 잘림). 잘린 응답 끝부분: ...${text.slice(-200)}`);
    }
    return [];
  }
}

export const handler = async (event) => {
  const { owner, repo, prNumber } = event;
  let { headSha } = event;

  const octokit = await createOctokit();

  if (!headSha) {
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    headSha = pr.data.head.sha;
  }

  const checkRunId = await createCheck(octokit, owner, repo, headSha);

  try {
    const diffRes = await octokit.rest.pulls.get({
      owner, repo, pull_number: prNumber,
      mediaType: { format: "diff" },
    });

    const files = parseDiff(diffRes.data);
    const comments = [];

    for (const file of files) {
      // diff row 기반 유효 라인 셋 구축 (side별)
      const validLines = { RIGHT: new Map(), LEFT: new Map() };
      for (const row of file.rows) {
        if (row.type === "add" || row.type === "context") {
          validLines.RIGHT.set(row.newLine, row.content);
        }
        if (row.type === "delete") {
          validLines.LEFT.set(row.oldLine, row.content);
        }
        if (row.type === "context") {
          validLines.LEFT.set(row.oldLine, row.content);
        }
      }

      const annotatedDiff = buildAnnotatedDiff(file.rows);
      if (!annotatedDiff) continue;

      const reviews = await reviewFile(file.path, annotatedDiff.slice(0, 10000));

      for (const r of reviews) {
        if (!r.line || !r.body) continue;

        const side = r.side === "LEFT" ? "LEFT" : "RIGHT";
        const sideMap = validLines[side];

        // LLM이 반환한 라인이 diff 범위 내인지 검증
        if (!sideMap.has(r.line)) {
          console.warn(`[SKIP] ${file.path}:${r.line} (${side}) — diff 범위 밖`);
          continue;
        }

        // suggestion이 LEFT에 달려있으면 suggestion 제거 (GitHub에서 LEFT suggestion 불가)
        let body = r.body;
        if (side === "LEFT") {
          body = body.replace(/\n?\n?```suggestion\n[\s\S]*?\n```/, "");
        }

        const comment = { path: file.path, line: r.line, side, body };

        // 멀티라인 지원
        if (r.start_line && r.start_line < r.line) {
          comment.start_line = r.start_line;
          comment.start_side = r.start_side === "LEFT" ? "LEFT" : side;
        }

        comments.push(comment);
      }
    }

    const summaryBody = buildSummary(comments);
    await octokit.rest.pulls.createReview({
      owner, repo, pull_number: prNumber,
      commit_id: headSha,
      event: comments.length > 0 ? "COMMENT" : "APPROVE",
      body: summaryBody,
      comments,
    });

    await completeCheck(octokit, owner, repo, checkRunId, "success", `리뷰 완료: ${comments.length}건의 피드백`);
    return { status: "reviewed", comments: comments.length };
  } catch (err) {
    await completeCheck(octokit, owner, repo, checkRunId, "failure", `리뷰 중 오류 발생: ${err.message}`);
    throw err;
  }
};
