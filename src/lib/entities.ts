import type Redis from "ioredis";
import type { Board, Job, JobRun, User } from "./types.js";

/* ── Key helpers ── */
const K = {
  board: (id: string) => `board:${id}`,
  boardsIdx: () => "idx:boards",
  job: (board: string, jobId: string) => `job:${board}:${jobId}`,
  boardJobsIdx: (board: string) => `idx:board_jobs:${board}`,
  jobStatusIdx: (status: string) => `idx:job_status:${status}`,
  run: (runId: string) => `run:${runId}`,
  jobRunsIdx: (jobId: string) => `idx:job_runs:${jobId}`,
  runsAll: () => "idx:runs",
  user: (id: string) => `user:${id}`,
  usersIdx: () => "idx:users",
};

/* ══════════════════════ Boards ══════════════════════ */

export async function addBoard(r: Redis, id: string, company: string): Promise<Board> {
  const board: Board = { id, company, created_at: new Date().toISOString() };
  const pipe = r.pipeline();
  pipe.hset(K.board(id), { id, company, created_at: board.created_at });
  pipe.sadd(K.boardsIdx(), id);
  await pipe.exec();
  return board;
}

export async function removeBoard(r: Redis, id: string): Promise<boolean> {
  const exists = await r.exists(K.board(id));
  if (!exists) return false;

  const jobIds = await r.smembers(K.boardJobsIdx(id));
  const pipe = r.pipeline();
  for (const jobId of jobIds) {
    const jobKey = K.job(id, jobId);
    const jobData = await r.hget(jobKey, "status");
    if (jobData) pipe.srem(K.jobStatusIdx(jobData), `${id}:${jobId}`);
    pipe.del(jobKey);
  }
  pipe.del(K.boardJobsIdx(id));
  pipe.del(K.board(id));
  pipe.srem(K.boardsIdx(), id);
  await pipe.exec();
  return true;
}

export async function listBoards(r: Redis): Promise<Board[]> {
  const ids = await r.smembers(K.boardsIdx());
  if (ids.length === 0) return [];
  const boards = await Promise.all(
    ids.map(async (id) => {
      const data = await r.hgetall(K.board(id));
      return data.id ? (data as unknown as Board) : null;
    })
  );
  return boards.filter((b): b is Board => b !== null);
}

export async function getBoard(r: Redis, id: string): Promise<Board | null> {
  const data = await r.hgetall(K.board(id));
  return data.id ? (data as unknown as Board) : null;
}

/* ══════════════════════ Jobs ══════════════════════ */

export async function addJob(r: Redis, job: Omit<Job, "discovered_at" | "updated_at" | "status">): Promise<Job> {
  const now = new Date().toISOString();
  const full: Job = { ...job, status: "discovered", discovered_at: now, updated_at: now };
  const pipe = r.pipeline();
  pipe.hset(K.job(job.board, job.job_id), {
    job_id: full.job_id,
    board: full.board,
    title: full.title,
    url: full.url,
    location: full.location,
    department: full.department,
    status: full.status,
    discovered_at: full.discovered_at,
    updated_at: full.updated_at,
  });
  pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
  pipe.sadd(K.jobStatusIdx("discovered"), `${job.board}:${job.job_id}`);
  await pipe.exec();
  return full;
}

export async function addJobsBulk(r: Redis, jobs: Omit<Job, "discovered_at" | "updated_at" | "status">[]): Promise<Job[]> {
  const now = new Date().toISOString();
  const results: Job[] = [];
  const pipe = r.pipeline();

  for (const job of jobs) {
    const full: Job = { ...job, status: "discovered", discovered_at: now, updated_at: now };
    pipe.hset(K.job(job.board, job.job_id), {
      job_id: full.job_id,
      board: full.board,
      title: full.title,
      url: full.url,
      location: full.location,
      department: full.department,
      status: full.status,
      discovered_at: full.discovered_at,
      updated_at: full.updated_at,
    });
    pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
    pipe.sadd(K.jobStatusIdx("discovered"), `${job.board}:${job.job_id}`);
    results.push(full);
  }

  await pipe.exec();
  return results;
}

export async function removeJob(r: Redis, board: string, jobId: string): Promise<boolean> {
  const key = K.job(board, jobId);
  const data = await r.hgetall(key);
  if (!data.job_id) return false;

  const pipe = r.pipeline();
  if (data.status) pipe.srem(K.jobStatusIdx(data.status), `${board}:${jobId}`);
  pipe.srem(K.boardJobsIdx(board), jobId);
  pipe.del(key);
  await pipe.exec();
  return true;
}

export async function updateJobStatus(
  r: Redis,
  board: string,
  jobId: string,
  newStatus: Job["status"]
): Promise<Job | null> {
  const key = K.job(board, jobId);
  const data = await r.hgetall(key);
  if (!data.job_id) return null;

  const oldStatus = data.status;
  const now = new Date().toISOString();
  const pipe = r.pipeline();
  pipe.hset(key, { status: newStatus, updated_at: now });
  if (oldStatus) pipe.srem(K.jobStatusIdx(oldStatus), `${board}:${jobId}`);
  pipe.sadd(K.jobStatusIdx(newStatus), `${board}:${jobId}`);
  await pipe.exec();

  return { ...(data as unknown as Job), status: newStatus, updated_at: now };
}

export async function getJob(r: Redis, board: string, jobId: string): Promise<Job | null> {
  const data = await r.hgetall(K.job(board, jobId));
  return data.job_id ? (data as unknown as Job) : null;
}

export async function listJobs(r: Redis, opts?: { board?: string; status?: string }): Promise<Job[]> {
  let compositeKeys: string[];

  if (opts?.board && opts?.status) {
    const boardJobs = await r.smembers(K.boardJobsIdx(opts.board));
    const statusJobs = await r.smembers(K.jobStatusIdx(opts.status));
    const statusSet = new Set(statusJobs);
    compositeKeys = boardJobs
      .map((jid) => `${opts.board}:${jid}`)
      .filter((ck) => statusSet.has(ck));
  } else if (opts?.board) {
    const jobIds = await r.smembers(K.boardJobsIdx(opts.board));
    compositeKeys = jobIds.map((jid) => `${opts.board}:${jid}`);
  } else if (opts?.status) {
    compositeKeys = await r.smembers(K.jobStatusIdx(opts.status));
  } else {
    const boardIds = await r.smembers(K.boardsIdx());
    compositeKeys = [];
    for (const bid of boardIds) {
      const jids = await r.smembers(K.boardJobsIdx(bid));
      compositeKeys.push(...jids.map((jid) => `${bid}:${jid}`));
    }
  }

  const jobs = await Promise.all(
    compositeKeys.map(async (ck) => {
      const [board, jobId] = ck.split(":");
      const data = await r.hgetall(K.job(board, jobId));
      return data.job_id ? (data as unknown as Job) : null;
    })
  );
  return jobs.filter((j): j is Job => j !== null);
}

/* ══════════════════════ JobRuns ══════════════════════ */

export async function createRun(r: Redis, run: Omit<JobRun, "started_at" | "completed_at" | "error" | "status">): Promise<JobRun> {
  const now = new Date().toISOString();
  const full: JobRun = { ...run, status: "pending", started_at: now, completed_at: null, error: null };
  const pipe = r.pipeline();
  pipe.hset(K.run(run.run_id), {
    run_id: full.run_id,
    job_id: full.job_id,
    board: full.board,
    variant_id: full.variant_id,
    status: full.status,
    started_at: full.started_at,
    completed_at: "",
    error: "",
  });
  pipe.sadd(K.jobRunsIdx(run.job_id), run.run_id);
  pipe.sadd(K.runsAll(), run.run_id);
  await pipe.exec();
  return full;
}

export async function updateRun(
  r: Redis,
  runId: string,
  update: { status: JobRun["status"]; error?: string }
): Promise<JobRun | null> {
  const key = K.run(runId);
  const data = await r.hgetall(key);
  if (!data.run_id) return null;

  const now = new Date().toISOString();
  const fields: Record<string, string> = { status: update.status };
  if (update.status === "success" || update.status === "failed") {
    fields.completed_at = now;
  }
  if (update.error) fields.error = update.error;

  await r.hset(key, fields);
  const updated = await r.hgetall(key);
  return {
    ...(updated as unknown as JobRun),
    completed_at: updated.completed_at || null,
    error: updated.error || null,
  };
}

export async function listRuns(r: Redis, jobId?: string): Promise<JobRun[]> {
  const runIds = jobId
    ? await r.smembers(K.jobRunsIdx(jobId))
    : await r.smembers(K.runsAll());

  const runs = await Promise.all(
    runIds.map(async (rid) => {
      const data = await r.hgetall(K.run(rid));
      if (!data.run_id) return null;
      return {
        ...(data as unknown as JobRun),
        completed_at: data.completed_at || null,
        error: data.error || null,
      };
    })
  );
  return runs.filter((r): r is JobRun => r !== null);
}

/* ══════════════════════ Users ══════════════════════ */

export async function upsertUser(r: Redis, id: string, resumes: string[], answers: Record<string, string>): Promise<User> {
  const now = new Date().toISOString();
  const pipe = r.pipeline();
  pipe.hset(K.user(id), {
    id,
    resumes: JSON.stringify(resumes),
    answers: JSON.stringify(answers),
    updated_at: now,
  });
  pipe.sadd(K.usersIdx(), id);
  await pipe.exec();
  return { id, resumes, answers, updated_at: now };
}

export async function getUser(r: Redis, id: string): Promise<User | null> {
  const data = await r.hgetall(K.user(id));
  if (!data.id) return null;
  return {
    id: data.id,
    resumes: JSON.parse(data.resumes || "[]"),
    answers: JSON.parse(data.answers || "{}"),
    updated_at: data.updated_at,
  };
}

export async function listUsers(r: Redis): Promise<User[]> {
  const ids = await r.smembers(K.usersIdx());
  const users = await Promise.all(ids.map((id) => getUser(r, id)));
  return users.filter((u): u is User => u !== null);
}
