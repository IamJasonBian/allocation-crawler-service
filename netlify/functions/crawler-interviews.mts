import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import {
  createInterviewStage,
  getInterviewStage,
  listInterviewStages,
  removeInterviewStage,
  updateInterviewStage,
} from "../../src/lib/entities.js";
import type { InterviewStatus } from "../../src/lib/types.js";
import { INTERVIEW_STATUSES } from "../../src/lib/types.js";
import { optionalAuth } from "../../src/lib/auth.js";

/**
 * /api/crawler/interviews
 *
 * GET    - List interview stages; filter by ?user_id=, ?status=, ?board=.
 *          Pass ?user_id=&board=&job_id= for a single record.
 * POST   - Create a stage for a (user_id, board, job_id) tuple.
 * PATCH  - Update status and/or notes on an existing stage.
 * DELETE - Remove a stage (e.g. on re-application).
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const authResult = await optionalAuth(req);
    if ("error" in authResult) return authResult.error;

    const url = new URL(req.url);

    if (req.method === "GET") {
      const userId = url.searchParams.get("user_id");
      const board = url.searchParams.get("board");
      const jobId = url.searchParams.get("job_id");
      const status = url.searchParams.get("status");

      if (userId && board && jobId) {
        const stage = await getInterviewStage(r, userId, board, jobId);
        if (!stage) return json({ error: "Interview stage not found" }, 404);
        return json(stage);
      }

      if (status && !isInterviewStatus(status)) {
        return json({ error: `Invalid status '${status}'`, allowed: INTERVIEW_STATUSES }, 400);
      }

      const stages = await listInterviewStages(r, {
        ...(userId ? { user_id: userId } : {}),
        ...(status ? { status: status as InterviewStatus } : {}),
        ...(board ? { board } : {}),
      });
      return json({ count: stages.length, stages });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.user_id || !body.board || !body.job_id) {
        return json({ error: "user_id, board, and job_id are required" }, 400);
      }
      if (body.status && !isInterviewStatus(body.status)) {
        return json({ error: `Invalid status '${body.status}'`, allowed: INTERVIEW_STATUSES }, 400);
      }
      const result = await createInterviewStage(r, {
        user_id: String(body.user_id),
        board: String(body.board),
        job_id: String(body.job_id),
        status: body.status as InterviewStatus | undefined,
        notes: body.notes != null ? String(body.notes) : "",
      });
      if ("error" in result) return json({ error: result.error }, result.code);
      return json(result.stage, 201);
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      if (!body.user_id || !body.board || !body.job_id) {
        return json({ error: "user_id, board, and job_id are required" }, 400);
      }
      if (body.status === undefined && body.notes === undefined) {
        return json({ error: "At least one of status or notes is required" }, 400);
      }
      if (body.status && !isInterviewStatus(body.status)) {
        return json({ error: `Invalid status '${body.status}'`, allowed: INTERVIEW_STATUSES }, 400);
      }
      const stage = await updateInterviewStage(
        r,
        String(body.user_id),
        String(body.board),
        String(body.job_id),
        {
          ...(body.status ? { status: body.status as InterviewStatus } : {}),
          ...(body.notes !== undefined ? { notes: String(body.notes) } : {}),
        },
      );
      if (!stage) return json({ error: "Interview stage not found" }, 404);
      return json(stage);
    }

    if (req.method === "DELETE") {
      const body = await req.json();
      if (!body.user_id || !body.board || !body.job_id) {
        return json({ error: "user_id, board, and job_id are required" }, 400);
      }
      const removed = await removeInterviewStage(
        r,
        String(body.user_id),
        String(body.board),
        String(body.job_id),
      );
      if (!removed) return json({ error: "Interview stage not found" }, 404);
      return json({ success: true });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-interviews error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis(r);
  }
};

function isInterviewStatus(s: string): s is InterviewStatus {
  return (INTERVIEW_STATUSES as string[]).includes(s);
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/crawler/interviews",
  method: ["GET", "POST", "PATCH", "DELETE"],
};
