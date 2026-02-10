import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { createHmac } from "crypto";

const lambda = new LambdaClient();
const SECRET = process.env.WEBHOOK_SECRET;
const WORKER = process.env.REVIEW_WORKER_NAME;

// GitHub webhook 서명 검증
function verifySignature(body, signature) {
  const expected = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  return expected === signature;
}

export const handler = async (event) => {
  const body = event.body;
  const sig = event.headers?.["x-hub-signature-256"] || "";

  if (!verifySignature(body, sig)) {
    return { statusCode: 401, body: "Invalid signature" };
  }

  const payload = JSON.parse(body);
  const ghEvent = event.headers?.["x-github-event"];

  // PR 열림/동기화(새 커밋 push) 이벤트만 처리
  if (ghEvent !== "pull_request" || !["opened", "synchronize"].includes(payload.action)) {
    return { statusCode: 200, body: "ignored" };
  }

  const pr = payload.pull_request;

  await lambda.send(new InvokeCommand({
    FunctionName: WORKER,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: pr.number,
      headSha: pr.head.sha,
    })),
  }));

  return { statusCode: 200, body: "dispatched" };
};
