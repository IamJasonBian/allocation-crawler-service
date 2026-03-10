import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { createRun, updateRun, getJob } from "../../src/lib/entities.js";
import { applyToJob } from "../../src/lib/greenhouse-apply.js";
import type { CandidateProfile } from "../../src/lib/greenhouse-apply.js";

/**
 * /api/crawler/apply — Background function for job applications.
 *
 * Runs as a Netlify Background Function (up to 15 min timeout).
 * Orchestrates: claim job → apply via form POST or browser → update run with artifacts.
 *
 * POST {
 *   board: string,
 *   job_id: string,
 *   variant_id: string,
 *   mode?: "form_post" | "browser" | "auto",  // default: auto
 *   candidate: CandidateProfile,               // or omit to use CANDIDATE_JSON env
 * }
 *
 * Returns 202 immediately (background processing).
 * Results are stored in the run entity (GET /api/crawler/jobs?runs_for=<job_id>).
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const body = await req.json();
    const { board, job_id, variant_id, mode } = body;

    if (!board || !job_id || !variant_id) {
      return json({ error: "board, job_id, and variant_id are required" }, 400);
    }

    // Resolve candidate profile
    const candidate: CandidateProfile = body.candidate || parseCandidateEnv();
    if (!candidate) {
      return json({ error: "candidate profile required (in body or CANDIDATE_JSON env)" }, 400);
    }

    // Generate a unique run ID
    const runId = `apply-${board}-${job_id}-${Date.now()}`;

    // 1. Claim the job via SETNX lock + createRun
    const result = await createRun(r, {
      run_id: runId,
      job_id,
      board,
      variant_id,
    }, {
      resume_url: candidate.resumePath || variant_id,
      notes: `Mode: ${mode || "auto"}`,
    });

    if ("error" in result) {
      return json({ error: result.error }, result.code);
    }

    // 2. Apply to the job
    const applyResult = await applyToJob(board, job_id, candidate, mode);

    // 3. Update run with result
    if (applyResult.success) {
      await updateRun(r, runId, {
        status: "success",
        artifacts: {
          confirmation_url: applyResult.confirmationUrl,
          answers: applyResult.answersSubmitted,
          notes: `${applyResult.method}: ${applyResult.message}`,
        },
      });
    } else {
      await updateRun(r, runId, {
        status: "failed",
        error: applyResult.message,
        artifacts: {
          answers: applyResult.answersSubmitted,
          notes: `${applyResult.method}: ${applyResult.message}`,
        },
      });
    }

    // Fetch the final job state for the response
    const job = await getJob(r, board, job_id);

    return json({
      run_id: runId,
      success: applyResult.success,
      method: applyResult.method,
      message: applyResult.message,
      job_status: job?.status,
      confirmation_url: applyResult.confirmationUrl,
    }, applyResult.success ? 200 : 422);
  } catch (error: any) {
    console.error("crawler-apply error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis(r);
  }
};

function parseCandidateEnv(): CandidateProfile | null {
  const raw = process.env.CANDIDATE_JSON;
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/crawler/apply",
  method: ["POST"],
};
