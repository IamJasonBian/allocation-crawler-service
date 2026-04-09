/* ── Test Client ──
 *
 * Starts one ApplyToJobWorkflow execution against a local Temporal
 * server, then sends an agentCompleted signal a few seconds later so
 * you can watch the whole lifecycle in the UI at localhost:8233.
 *
 *   npm run test-apply
 *
 * Optional positional args: <board> <job_id> <user_id>
 *   npm run test-apply -- stripe abc123 user-7
 */

import { Client, Connection } from "@temporalio/client";
import { applyToJobWorkflow, agentCompletedSignal } from "./workflows.js";
import { APPLY_TASK_QUEUE } from "./constants.js";
import type {
  ApplyContext,
  AgentCompletedPayload,
} from "../lib/apply-types.js";

async function main() {
  const [, , board = "stripe", job_id = "demo-1", user_id = "user-1"] =
    process.argv;
  const ctx: ApplyContext = { board, job_id, user_id };
  const workflowId = `apply:${board}:${job_id}:${user_id}`;

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";

  console.log(`[test-client] connecting to ${address}`);
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  console.log(`[test-client] starting workflow id=${workflowId}`);
  const handle = await client.workflow.start(applyToJobWorkflow, {
    taskQueue: APPLY_TASK_QUEUE,
    workflowId,
    args: [ctx],
    workflowIdReusePolicy: "ALLOW_DUPLICATE_FAILED_ONLY",
  });
  console.log(`[test-client] started, run_id=${handle.firstExecutionRunId}`);

  // Simulate the agent calling back after a short delay.
  setTimeout(async () => {
    const payload: AgentCompletedPayload = {
      status: "submitted",
      artifacts: {
        confirmation_url: "https://example.com/confirmed/demo-1",
        notes: "fake agent callback from test-client",
      },
    };
    console.log("[test-client] sending agentCompleted signal");
    await handle.signal(agentCompletedSignal, payload);
  }, 3000);

  const result = await handle.result();
  console.log("[test-client] workflow result:", result);
  await connection.close();
}

main().catch((err) => {
  console.error("[test-client] fatal:", err);
  process.exit(1);
});
