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
  const ghEvent = event.headers?.["x-github-event"];

  console.log("Event:", ghEvent, "Signature present:", !!sig);

  if (!verifySignature(body, sig)) {
    console.log("Signature verification failed");
    return { statusCode: 401, body: "Invalid signature" };
  }

  const payload = JSON.parse(body);
  console.log("Action:", payload.action);

  let pr;

  if (ghEvent === "pull_request" && payload.action === "opened") {
    // PR 열림 이벤트
    pr = payload.pull_request;
  } else if (ghEvent === "issue_comment" && payload.action === "created"
    && payload.issue?.pull_request && payload.comment?.body?.trim() === "/review") {
    // PR 코멘트에 /review 커맨드
    pr = payload.issue.pull_request;
  } else {
    console.log("Ignored:", ghEvent, payload.action);
    return { statusCode: 200, body: "ignored" };
  }

  const workerPayload = {
    owner: payload.repository.owner.login,
    repo: payload.repository.name,
    prNumber: payload.issue?.number || payload.pull_request.number,
    headSha: pr.head?.sha || null,
  };
  console.log("Dispatching to worker:", JSON.stringify(workerPayload));

  await lambda.send(new InvokeCommand({
    FunctionName: WORKER,
    InvocationType: "Event",
    Payload: new TextEncoder().encode(JSON.stringify(workerPayload)),
  }));

  return { statusCode: 200, body: "dispatched" };
};
