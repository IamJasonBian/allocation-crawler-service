/* ── ApplyToJobWorkflow ──
 *
 * The durable state machine for one (board, job_id, user_id) apply
 * attempt. Replaces the SETNX-locked, non-transactional Redis path in
 * crawler-jobs.mts handleAction "run".
 *
 * Phases:
 *   1. Snapshot job + user (frozen, replay-stable)
 *   2. Create the Run record (status = pending)
 *   3. Dispatch the form-filling agent (HTTP POST)
 *   4. Wait for the agent's callback signal, with a hard timeout
 *   5. Verify the agent returned a confirmation_url
 *   6. Mark success and notify Slack
 *
 * Dedupe: workflow id is `apply:${board}:${job_id}:${user_id}`. Started
 * with WorkflowIdReusePolicy controlling re-application semantics.
 *
 * IMPORTANT: workflow code is sandboxed and must be deterministic. No
 * Date.now(), no Math.random(), no direct I/O — all of that lives in
 * activities (see ./activities.ts).
 */

import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  log,
} from "@temporalio/workflow";

import type {
  ApplyContext,
  ApplyResult,
  AgentCompletedPayload,
} from "../lib/apply-types";
import {
  AGENT_COMPLETED_SIGNAL,
  CANCEL_SIGNAL,
} from "../lib/apply-types";

import type * as activities from "./activities";

const {
  snapshotApplyInputs,
  createRunActivity,
  dispatchAgentActivity,
  verifyRunArtifactsActivity,
  markRunSuccessActivity,
  markRunFailedActivity,
  notifySlackActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "60 seconds",
  retry: {
    maximumAttempts: 5,
    initialInterval: "15 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
  },
});

export const agentCompletedSignal =
  defineSignal<[AgentCompletedPayload]>(AGENT_COMPLETED_SIGNAL);

export const cancelSignal = defineSignal<[]>(CANCEL_SIGNAL);

interface ApplyState {
  agentResult: AgentCompletedPayload | null;
  cancelled: boolean;
}

export async function applyToJobWorkflow(
  ctx: ApplyContext,
): Promise<ApplyResult> {
  // Wrapped in an object so signal-driven mutations survive TypeScript's
  // closure narrowing across awaits.
  const state: ApplyState = { agentResult: null, cancelled: false };

  setHandler(agentCompletedSignal, (payload) => {
    state.agentResult = payload;
  });
  setHandler(cancelSignal, () => {
    state.cancelled = true;
  });

  log.info("apply.start", { ctx });

  // Phase 1: snapshot
  const snapshot = await snapshotApplyInputs(ctx);

  // Phase 2: create run record
  const run_id = await createRunActivity(ctx, snapshot);

  // Phase 3: dispatch the agent (fire-and-forget; agent calls back via signal)
  await dispatchAgentActivity({
    run_id,
    workflow_id: workflowInfo().workflowId,
    snapshot,
  });

  // Phase 4: durable wait for the agent callback (or cancellation)
  const got = await condition(
    () => state.agentResult !== null || state.cancelled,
    "2 hours",
  );

  if (state.cancelled) {
    await markRunFailedActivity(run_id, "cancelled");
    return { status: "cancelled", run_id, reason: "cancelled_by_signal" };
  }

  if (!got || state.agentResult === null) {
    await markRunFailedActivity(run_id, "agent_timeout");
    return { status: "failed", run_id, reason: "agent_timeout" };
  }

  const result = state.agentResult;

  if (result.status === "failed") {
    await markRunFailedActivity(run_id, "agent_reported_failure");
    return { status: "failed", run_id, reason: "agent_reported_failure" };
  }

  // Phase 5: verify
  const verification = await verifyRunArtifactsActivity(run_id, result);
  if (!verification.has_confirmation_url) {
    return { status: "submitted_unverified", run_id };
  }

  // Phase 6: mark success + notify
  await markRunSuccessActivity(run_id, result);
  await notifySlackActivity(run_id);

  return { status: "success", run_id };
}
