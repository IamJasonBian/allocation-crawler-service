/* ── Apply Worker ──
 *
 * Long-running process that hosts ApplyToJobWorkflow + its activities
 * and polls the Temporal cluster on the "apply" task queue.
 *
 * Local dev:
 *   1. terminal A:  temporal server start-dev
 *   2. terminal B:  npm run worker
 *   3. terminal C:  npm run test-apply
 *
 * Production: same binary, different env vars (TEMPORAL_ADDRESS,
 * TEMPORAL_NAMESPACE, TEMPORAL_TLS, TEMPORAL_CLIENT_CERT,
 * TEMPORAL_CLIENT_KEY).
 */

import { fileURLToPath } from "url";
import path from "path";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { APPLY_TASK_QUEUE } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";

  console.log(`[worker] connecting to ${address} (namespace=${namespace})`);
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: APPLY_TASK_QUEUE,
    workflowsPath: path.join(__dirname, "workflows.ts"),
    activities,
  });

  console.log(`[worker] started, polling task queue "${APPLY_TASK_QUEUE}"`);
  await worker.run();
}

run().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
