/* ── Apply Workflow Types ──
 *
 * Type-only contract for the upcoming apply-workflow rewrite.
 *
 * Today the apply path lives inside crawler-jobs.mts handleAction "run":
 * a Netlify function that writes Redis directly, guarded by a SETNX lock.
 * The rewrite moves it into a Temporal workflow (one execution per
 * (board, job_id, user_id)) so that:
 *
 *   - dedupe is the workflow id, not a TTL'd Redis lock
 *   - the agent callback is a signal, not a non-transactional Redis write
 *   - dispatch → wait → verify → notify is one durable state machine
 *   - in-flight applies survive worker crashes
 *
 * This file is intentionally type-only. No imports from @temporalio/*,
 * no runtime code. Subsequent PRs will add:
 *   - src/temporal/workflows.ts        the workflow itself
 *   - src/temporal/activities.ts       activities wrapping entities.ts
 *   - src/temporal/worker.ts           worker entry point
 *   - edits to crawler-jobs.mts        start workflow / forward signals
 *
 * Reuses Job, User, RunArtifacts, RunStatus from ./types so the new
 * vocabulary stays anchored to existing entities.
 */

import type { Job, User, RunArtifacts } from "./types";

/* ══════════════════════ Workflow Input ══════════════════════ */

/**
 * Identifies a single apply attempt: one user applying to one job on one
 * board. Used both as the workflow argument and as the dedupe key —
 * workflow id is `apply:${board}:${job_id}:${user_id}`.
 */
export interface ApplyContext {
  board: string;     // board id (e.g. "stripe")
  job_id: string;    // posting id within that board
  user_id: string;   // applicant
}

/* ══════════════════════ Snapshot ══════════════════════ */

/**
 * Frozen view of the inputs the workflow operates on, captured in the
 * first activity. Once snapshotted, every downstream step references
 * this object instead of re-reading Redis — so retries see the same
 * job and user state the original attempt did, even if the underlying
 * row changes mid-flight.
 */
export interface ApplySnapshot {
  job: Job;
  user: User;
  snapshot_at: string;   // ISO timestamp
}

/* ══════════════════════ Workflow Result ══════════════════════ */

/**
 * Terminal state of a single apply workflow execution.
 *
 *   success              — agent submitted AND confirmation_url present
 *   submitted_unverified — agent submitted but no confirmation_url
 *                          (treated as "applied" by the existing audit
 *                          but flagged separately for follow-up)
 *   failed               — dispatch failed, agent timed out, or any
 *                          other unrecoverable error
 *   cancelled            — explicit cancel signal was received
 */
export type ApplyStatus =
  | "success"
  | "submitted_unverified"
  | "failed"
  | "cancelled";

export interface ApplyResult {
  status: ApplyStatus;
  run_id: string;
  reason?: string;       // populated for failed / cancelled
}

/* ══════════════════════ Agent Callback Signal ══════════════════════ */

/**
 * Payload of the signal the agent service sends back when it finishes
 * filling the form. Today this arrives as a PATCH to crawler-jobs.mts;
 * after the rewrite the handler forwards it as a Temporal signal to the
 * matching workflow.
 *
 * `status` is the agent's own report (separate from ApplyStatus, which
 * is the workflow's verdict after verification). `artifacts` reuses the
 * existing RunArtifacts shape so the agent contract is unchanged.
 */
export interface AgentCompletedPayload {
  status: "submitted" | "failed";
  artifacts: RunArtifacts;
}

/* ══════════════════════ Signal Names ══════════════════════ */

/**
 * String constants for signal names. Both the workflow definition and
 * the callback handler in crawler-jobs.mts must use these exact names —
 * keeping them as a single source of truth here prevents the two sides
 * from drifting.
 */
export const AGENT_COMPLETED_SIGNAL = "agentCompleted" as const;
export const CANCEL_SIGNAL = "cancel" as const;

export type ApplySignalName =
  | typeof AGENT_COMPLETED_SIGNAL
  | typeof CANCEL_SIGNAL;
