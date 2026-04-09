/* ── Apply Workflow Activities (stubs) ──
 *
 * These are stand-ins for the real activities that will eventually wrap
 * the Redis-backed entities in src/lib/entities.ts. For now they log,
 * sleep briefly, and return fake but well-shaped data so the workflow
 * can be exercised end-to-end against a local Temporal dev server.
 *
 * The function signatures here are the contract the workflow depends
 * on via `proxyActivities<typeof activities>` — once we replace the
 * bodies with real entity calls, the workflow won't change.
 */

import type {
  ApplyContext,
  ApplySnapshot,
  AgentCompletedPayload,
} from "../lib/apply-types";
import type { Job, User } from "../lib/types";

const log = (msg: string, extra?: unknown) =>
  console.log(`[activity] ${msg}`, extra ?? "");

const fakeJob = (board: string, job_id: string): Job => ({
  job_id,
  board,
  title: `Fake job ${job_id}`,
  url: `https://example.com/${board}/${job_id}`,
  location: "Remote",
  department: "Engineering",
  tags: ["engineering"],
  content_hash: "fake-hash",
  status: "discovered",
  discovered_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  applied_at: null,
  applied_run_id: null,
});

const fakeUser = (user_id: string): User => ({
  id: user_id,
  resumes: [],
  answers: {},
  tags: [],
  updated_at: new Date().toISOString(),
});

export async function snapshotApplyInputs(
  ctx: ApplyContext,
): Promise<ApplySnapshot> {
  log("snapshotApplyInputs", ctx);
  return {
    job: fakeJob(ctx.board, ctx.job_id),
    user: fakeUser(ctx.user_id),
    snapshot_at: new Date().toISOString(),
  };
}

export async function createRunActivity(
  ctx: ApplyContext,
  _snapshot: ApplySnapshot,
): Promise<string> {
  const run_id = `run-${ctx.board}-${ctx.job_id}-${Date.now()}`;
  log("createRunActivity", { ctx, run_id });
  return run_id;
}

export async function dispatchAgentActivity(args: {
  run_id: string;
  workflow_id: string;
  snapshot: ApplySnapshot;
}): Promise<void> {
  log("dispatchAgentActivity", {
    run_id: args.run_id,
    workflow_id: args.workflow_id,
  });
  // Real impl: POST to AGENT_DISPATCH_URL with {run_id, workflow_id, snapshot}
}

export async function verifyRunArtifactsActivity(
  run_id: string,
  payload: AgentCompletedPayload,
): Promise<{ has_confirmation_url: boolean }> {
  const has_confirmation_url = Boolean(payload.artifacts?.confirmation_url);
  log("verifyRunArtifactsActivity", { run_id, has_confirmation_url });
  return { has_confirmation_url };
}

export async function markRunSuccessActivity(
  run_id: string,
  payload: AgentCompletedPayload,
): Promise<void> {
  log("markRunSuccessActivity", { run_id, status: payload.status });
  // Real impl: entities.updateRun(run_id, {status: "success", artifacts: payload.artifacts})
}

export async function markRunFailedActivity(
  run_id: string,
  reason: string,
): Promise<void> {
  log("markRunFailedActivity", { run_id, reason });
  // Real impl: entities.updateRun(run_id, {status: "failed", error: reason})
}

export async function notifySlackActivity(run_id: string): Promise<void> {
  log("notifySlackActivity", { run_id });
  // Real impl: POST to SLACK_WEBHOOK_URL
}
