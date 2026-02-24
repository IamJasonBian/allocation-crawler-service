import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import {
  addJob,
  addJobsBulk,
  removeJob,
  updateJobStatus,
  getJob,
  listJobs,
  listJobsForUser,
  createRun,
  updateRun,
  listRuns,
} from "../../src/lib/entities.js";
import type { Job, JobRun } from "../../src/lib/types.js";

/**
 * /api/crawler/jobs
 *
 * GET                              - List jobs (?board=, ?status=, ?id=&board= for single)
 * GET  ?runs_for=<job_id>          - List runs (empty string for all)
 * POST  { job_id, board, ... }     - Add single job
 * POST  { jobs: [...] }            - Bulk add jobs
 * POST  { action: "run", ... }     - Create a job run
 * POST  { action: "notify", ... }  - Send Slack digest of discovered jobs
 * POST  { action: "cleanup", ... } - Remove processed jobs
 * POST  { action: "retrieve", ...} - Retrieve job_ids for allocation-agent
 * PATCH { board, job_id, status }  - Update job status
 * PATCH { run_id, status }         - Update run status
 * DELETE { board, job_id }         - Remove a job
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const url = new URL(req.url);

    /* ── GET ── */
    if (req.method === "GET") {
      const runsFor = url.searchParams.get("runs_for");
      if (runsFor !== null) {
        const runs = await listRuns(r, runsFor || undefined);
        return json({ count: runs.length, runs });
      }

      const board = url.searchParams.get("board") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const tag = url.searchParams.get("tag") || undefined;
      const id = url.searchParams.get("id");

      if (board && id) {
        const job = await getJob(r, board, id);
        if (!job) return json({ error: "Job not found" }, 404);
        return json(job);
      }

      const jobs = await listJobs(r, { board, status, tag });
      return json({ count: jobs.length, jobs });
    }

    /* ── POST ── */
    if (req.method === "POST") {
      const body = await req.json();

      if (body.action) {
        return handleAction(r, body);
      }

      if (Array.isArray(body.jobs)) {
        const results = await addJobsBulk(r, body.jobs);
        return json({ count: results.length, jobs: results }, 201);
      }

      if (!body.job_id || !body.board) {
        return json({ error: "job_id and board are required (or provide action/jobs)" }, 400);
      }
      const job = await addJob(r, {
        job_id: body.job_id,
        board: body.board,
        title: body.title || "",
        url: body.url || "",
        location: body.location || "",
        department: body.department || "",
      });
      return json(job, 201);
    }

    /* ── PATCH ── */
    if (req.method === "PATCH") {
      const body = await req.json();

      if (body.run_id) {
        if (!body.status) return json({ error: "status is required" }, 400);
        const validRunStatuses: JobRun["status"][] = ["pending", "submitted", "success", "failed"];
        if (!validRunStatuses.includes(body.status)) {
          return json({ error: `run status must be one of: ${validRunStatuses.join(", ")}` }, 400);
        }
        const updated = await updateRun(r, body.run_id, { status: body.status, error: body.error });
        if (!updated) return json({ error: "Run not found" }, 404);
        return json(updated);
      }

      if (!body.board || !body.job_id || !body.status) {
        return json({ error: "board, job_id, and status are required (or run_id for runs)" }, 400);
      }
      const validStatuses: Job["status"][] = ["discovered", "queued", "applied", "found", "rejected", "expired"];
      if (!validStatuses.includes(body.status)) {
        return json({ error: `job status must be one of: ${validStatuses.join(", ")}` }, 400);
      }
      const updated = await updateJobStatus(r, body.board, body.job_id, body.status);
      if (!updated) return json({ error: "Job not found" }, 404);
      return json(updated);
    }

    /* ── DELETE ── */
    if (req.method === "DELETE") {
      const body = await req.json();
      if (!body.board || !body.job_id) {
        return json({ error: "board and job_id are required" }, 400);
      }
      const removed = await removeJob(r, body.board, body.job_id);
      if (!removed) return json({ error: "Job not found" }, 404);
      return json({ success: true, board: body.board, job_id: body.job_id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-jobs error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis();
  }
};

/* ── Action handlers ── */

async function handleAction(r: any, body: any) {
  const { action } = body;

  if (action === "run") {
    if (!body.run_id || !body.job_id || !body.board || !body.variant_id) {
      return json({ error: "run_id, job_id, board, and variant_id are required" }, 400);
    }
    const run = await createRun(r, {
      run_id: body.run_id,
      job_id: body.job_id,
      board: body.board,
      variant_id: body.variant_id,
    });
    return json(run, 201);
  }

  if (action === "notify") {
    const jobs = await listJobs(r, { status: body.status || "discovered" });
    if (jobs.length === 0) return json({ message: "No jobs to notify", count: 0 });

    const grouped: Record<string, typeof jobs> = {};
    for (const job of jobs) {
      (grouped[job.board] ??= []).push(job);
    }

    const blocks: object[] = [
      { type: "header", text: { type: "plain_text", text: `Crawler: ${jobs.length} Job(s) Discovered` } },
    ];
    for (const [board, boardJobs] of Object.entries(grouped)) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${board}* (${boardJobs.length} jobs)` } });
      for (const job of boardJobs.slice(0, 10)) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `• <${job.url}|${job.title}> — ${job.location} / ${job.department}` },
        });
      }
      if (boardJobs.length > 10) {
        blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `...and ${boardJobs.length - 10} more from ${board}` }] });
      }
    }

    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks }),
      });
      if (!resp.ok) console.error(`Slack webhook failed (${resp.status}): ${await resp.text()}`);
    }

    return json({ message: "Notification sent", count: jobs.length, boards: Object.keys(grouped) });
  }

  if (action === "cleanup") {
    const jobs = await listJobs(r, { board: body.board, status: body.status || "applied" });
    let removed = 0;
    for (const job of jobs) {
      await removeJob(r, job.board, job.job_id);
      removed++;
    }
    return json({ message: "Cleanup complete", removed });
  }

  if (action === "retrieve") {
    // If user is specified, filter jobs by user's interest tags
    const jobs = body.user
      ? await listJobsForUser(r, body.user, { board: body.board, status: body.status || "discovered" })
      : await listJobs(r, { board: body.board, status: body.status || "discovered" });
    return json({
      count: jobs.length,
      jobs: jobs.map((j) => ({
        job_id: j.job_id,
        board: j.board,
        title: j.title,
        url: j.url,
        location: j.location,
        department: j.department,
        tags: j.tags,
        status: j.status,
      })),
    });
  }

  return json({ error: "action must be one of: run, notify, cleanup, retrieve" }, 400);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/crawler/jobs",
  method: ["GET", "POST", "PATCH", "DELETE"],
};
