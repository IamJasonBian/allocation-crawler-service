import type Redis from "ioredis";
import {
  listBoards,
  getBoard,
  addBoard,
  removeBoard,
  listJobs,
  getJob,
  listJobsForUser,
  createRun,
  updateRun,
  listRuns,
  checkApplied,
  updateJobStatus,
  getUser,
  upsertUser,
  listCrawls,
  reconcileIndexes,
} from "./entities.js";
import { crawlBoard } from "./fetchers.js";
import { addJobsBulk } from "./entities.js";
import type { ATSType, RunStatus, JobStatus } from "./types.js";

/* ── Tool schema types ── */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/* ── Tool definitions ── */

export const tools: ToolDef[] = [
  {
    name: "list_boards",
    description: "List all registered company boards.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_board",
    description: "Get a specific board by ID.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Board ID (e.g. 'stripe')" } },
      required: ["id"],
    },
  },
  {
    name: "add_board",
    description: "Register a new company board for crawling.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Slug identifier (e.g. 'stripe')" },
        company: { type: "string", description: "Display name (e.g. 'Stripe')" },
        ats: { type: "string", enum: ["greenhouse", "lever", "ashby"], description: "ATS platform" },
        career_page_url: { type: "string", description: "Public careers page URL" },
      },
      required: ["id", "company", "ats"],
    },
  },
  {
    name: "remove_board",
    description: "Remove a board and all its associated jobs.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Board ID to remove" } },
      required: ["id"],
    },
  },
  {
    name: "list_jobs",
    description: "List jobs from tracked company boards. Filter by board, status, or tag.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Filter by board ID" },
        status: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] },
        tag: { type: "string", description: "Filter by tag (e.g. 'quant', 'ml')" },
      },
    },
  },
  {
    name: "get_job",
    description: "Get a specific job by board and job_id.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID" },
        job_id: { type: "string", description: "Job ID" },
      },
      required: ["board", "job_id"],
    },
  },
  {
    name: "list_jobs_for_user",
    description: "List jobs matching the authenticated user's interest tags.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Filter by board ID" },
        status: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] },
      },
    },
  },
  {
    name: "claim_job",
    description: "Create a run — agent claims a job for application. Acquires a distributed lock to prevent duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Unique run ID" },
        job_id: { type: "string", description: "Job to apply to" },
        board: { type: "string", description: "Board the job belongs to" },
      },
      required: ["run_id", "job_id", "board"],
    },
  },
  {
    name: "update_run",
    description: "Update a run's status and optionally merge artifacts (confirmation_url, answers, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Run ID to update" },
        status: { type: "string", enum: ["pending", "submitted", "success", "failed"] },
        error: { type: "string", description: "Error message if failed" },
        artifacts: {
          type: "object",
          description: "Artifacts to merge (confirmation_url, answers, etc.)",
          properties: {
            resume_url: { type: "string" },
            cover_letter: { type: "string" },
            confirmation_url: { type: "string" },
            notes: { type: "string" },
            answers: { type: "object" },
          },
        },
      },
      required: ["run_id", "status"],
    },
  },
  {
    name: "list_runs",
    description: "List application runs, optionally filtered by job_id.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "Filter runs by job ID (omit for all)" },
      },
    },
  },
  {
    name: "check_applied",
    description: "Audit applied jobs — returns verified (with confirmation URL) vs unverified.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Filter by board ID" },
      },
    },
  },
  {
    name: "update_job_status",
    description: "Manually change a job's status.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "string", description: "Board ID" },
        job_id: { type: "string", description: "Job ID" },
        status: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] },
      },
      required: ["board", "job_id", "status"],
    },
  },
  {
    name: "get_user_profile",
    description: "Get the authenticated user's profile including resumes, answers, and interest tags.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_user_profile",
    description: "Update the authenticated user's profile (tags, default answers).",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Interest tags for job matching" },
        answers: { type: "object", description: "Default form answers (e.g. visa status, YoE)" },
      },
    },
  },
  {
    name: "crawl_boards",
    description: "Trigger a crawl of all registered boards to discover new jobs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_crawls",
    description: "List crawl execution history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reconcile_indexes",
    description: "Rebuild Redis indexes from source job hashes. Admin operation for fixing inconsistencies.",
    inputSchema: { type: "object", properties: {} },
  },
];

/* ── Tool dispatch ── */

export async function handleToolCall(
  r: Redis,
  toolName: string,
  args: Record<string, unknown>,
  userId: string | null,
): Promise<ToolCallResult> {
  try {
    const result = await dispatch(r, toolName, args, userId);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

async function dispatch(
  r: Redis,
  name: string,
  args: Record<string, unknown>,
  userId: string | null,
): Promise<unknown> {
  switch (name) {
    case "list_boards":
      return listBoards(r);

    case "get_board":
      return getBoard(r, args.id as string) ?? { error: "Board not found" };

    case "add_board":
      return addBoard(r, args.id as string, args.company as string, args.ats as ATSType, (args.career_page_url as string) || "");

    case "remove_board": {
      const ok = await removeBoard(r, args.id as string);
      return ok ? { success: true } : { error: "Board not found" };
    }

    case "list_jobs":
      return listJobs(r, {
        board: args.board as string | undefined,
        status: args.status as string | undefined,
        tag: args.tag as string | undefined,
      });

    case "get_job":
      return getJob(r, args.board as string, args.job_id as string) ?? { error: "Job not found" };

    case "list_jobs_for_user": {
      if (!userId) return { error: "Authentication required for user-scoped queries" };
      return listJobsForUser(r, userId, {
        board: args.board as string | undefined,
        status: args.status as string | undefined,
      });
    }

    case "claim_job": {
      const result = await createRun(r, {
        run_id: args.run_id as string,
        job_id: args.job_id as string,
        board: args.board as string,
        user_id: userId || undefined,
      });
      if ("error" in result) return { error: result.error };
      return result.run;
    }

    case "update_run":
      return updateRun(r, args.run_id as string, {
        status: args.status as RunStatus,
        error: args.error as string | undefined,
        artifacts: args.artifacts as Record<string, unknown> | undefined,
      }) ?? { error: "Run not found" };

    case "list_runs":
      return listRuns(r, args.job_id as string | undefined);

    case "check_applied":
      return checkApplied(r, { board: args.board as string | undefined });

    case "update_job_status": {
      const updated = await updateJobStatus(r, args.board as string, args.job_id as string, args.status as JobStatus);
      return updated ?? { error: "Job not found" };
    }

    case "get_user_profile": {
      if (!userId) return { error: "Authentication required" };
      return getUser(r, userId) ?? { error: "User not found" };
    }

    case "update_user_profile": {
      if (!userId) return { error: "Authentication required" };
      const existing = await getUser(r, userId);
      return upsertUser(
        r,
        userId,
        existing?.resumes || [],
        args.answers ? { ...(existing?.answers || {}), ...(args.answers as Record<string, string>) } : existing?.answers || {},
        (args.tags as string[]) || existing?.tags || [],
      );
    }

    case "crawl_boards": {
      const boards = await listBoards(r);
      const summary: Record<string, { new: number; updated: number }> = {};
      let totalNew = 0;
      let totalUpdated = 0;
      for (const board of boards) {
        if (!board.ats) continue;
        try {
          const raw = await crawlBoard(board.id, board.ats);
          if (raw.length > 0) {
            const result = await addJobsBulk(r, raw.map((j) => ({ ...j, board: board.id })));
            summary[board.id] = { new: result.new.length, updated: result.updated };
            totalNew += result.new.length;
            totalUpdated += result.updated;
          } else {
            summary[board.id] = { new: 0, updated: 0 };
          }
        } catch (err: any) {
          summary[board.id] = { new: -1, updated: 0 };
        }
      }
      return { total_new: totalNew, total_updated: totalUpdated, boards: summary };
    }

    case "list_crawls":
      return listCrawls(r);

    case "reconcile_indexes":
      return reconcileIndexes(r);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
