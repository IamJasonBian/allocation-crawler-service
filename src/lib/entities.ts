import type Redis from "ioredis";
import type { Board, Job, JobRun, RunArtifacts, User } from "./types.js";
import { extractTags } from "./tags.js";

/* ── Pipeline helper ── */
async function execPipe(pipe: ReturnType<Redis["pipeline"]>) {
  const results = await pipe.exec();
  if (results) {
    for (const [err] of results) {
      if (err) throw err;
    }
  }
}

/* ── Key helpers ── */
const K = {
  board: (id: string) => `board:${id}`,
  boardsIdx: () => "idx:boards",
  job: (board: string, jobId: string) => `job:${board}:${jobId}`,
  boardJobsIdx: (board: string) => `idx:board_jobs:${board}`,
  jobStatusIdx: (status: string) => `idx:job_status:${status}`,
  tagIdx: (tag: string) => `idx:tag:${tag}`,
  run: (runId: string) => `run:${runId}`,
  jobRunsIdx: (jobId: string) => `idx:job_runs:${jobId}`,
  runsAll: () => "idx:runs",
  applyLock: (board: string, jobId: string) => `lock:apply:${board}:${jobId}`,
  user: (id: string) => `user:${id}`,
  usersIdx: () => "idx:users",
};

/* ══════════════════════ Boards ══════════════════════ */

export async function addBoard(r: Redis, id: string, company: string, ats: string): Promise<Board> {
  const board: Board = { id, company, ats, created_at: new Date().toISOString() };
  const pipe = r.pipeline();
  pipe.hset(K.board(id), { id, company, ats, created_at: board.created_at });
  pipe.sadd(K.boardsIdx(), id);
  await execPipe(pipe);
  return board;
}

export async function removeBoard(r: Redis, id: string): Promise<boolean> {
  const exists = await r.exists(K.board(id));
  if (!exists) return false;

  const jobIds = await r.smembers(K.boardJobsIdx(id));
  const pipe = r.pipeline();
  for (const jobId of jobIds) {
    const jobKey = K.job(id, jobId);
    const jobData = await r.hgetall(jobKey);
    if (jobData.status) pipe.srem(K.jobStatusIdx(jobData.status), `${id}:${jobId}`);
    if (jobData.tags) {
      for (const tag of jobData.tags.split(",")) {
        pipe.srem(K.tagIdx(tag), `${id}:${jobId}`);
      }
    }
    pipe.del(jobKey);
  }
  pipe.del(K.boardJobsIdx(id));
  pipe.del(K.board(id));
  pipe.srem(K.boardsIdx(), id);
  await execPipe(pipe);
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

export async function addJob(r: Redis, job: Omit<Job, "discovered_at" | "updated_at" | "status" | "tags">): Promise<Job> {
  const now = new Date().toISOString();
  const tags = extractTags(job.title, job.department);
  const full: Job = { ...job, tags, status: "discovered", discovered_at: now, updated_at: now };
  const ck = `${job.board}:${job.job_id}`;
  const pipe = r.pipeline();
  pipe.hset(K.job(job.board, job.job_id), {
    job_id: full.job_id,
    board: full.board,
    title: full.title,
    url: full.url,
    location: full.location,
    department: full.department,
    tags: tags.join(","),
    status: full.status,
    discovered_at: full.discovered_at,
    updated_at: full.updated_at,
  });
  pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
  pipe.sadd(K.jobStatusIdx("discovered"), ck);
  for (const tag of tags) {
    pipe.sadd(K.tagIdx(tag), ck);
  }
  await execPipe(pipe);
  return full;
}

export async function addJobsBulk(r: Redis, jobs: Omit<Job, "discovered_at" | "updated_at" | "status" | "tags">[]): Promise<Job[]> {
  if (jobs.length === 0) return [];

  // Check which jobs already exist — skip them to avoid resetting status
  const existChecks = await Promise.all(
    jobs.map((j) => r.exists(K.job(j.board, j.job_id)))
  );
  const newJobs = jobs.filter((_, i) => !existChecks[i]);
  if (newJobs.length === 0) return [];

  const now = new Date().toISOString();
  const results: Job[] = [];
  const pipe = r.pipeline();

  for (const job of newJobs) {
    const tags = extractTags(job.title, job.department);
    const full: Job = { ...job, tags, status: "discovered", discovered_at: now, updated_at: now };
    const ck = `${job.board}:${job.job_id}`;
    pipe.hset(K.job(job.board, job.job_id), {
      job_id: full.job_id,
      board: full.board,
      title: full.title,
      url: full.url,
      location: full.location,
      department: full.department,
      tags: tags.join(","),
      status: full.status,
      discovered_at: full.discovered_at,
      updated_at: full.updated_at,
    });
    pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
    pipe.sadd(K.jobStatusIdx("discovered"), ck);
    for (const tag of tags) {
      pipe.sadd(K.tagIdx(tag), ck);
    }
    results.push(full);
  }

  await execPipe(pipe);
  return results;
}

export async function removeJob(r: Redis, board: string, jobId: string): Promise<boolean> {
  const key = K.job(board, jobId);
  const data = await r.hgetall(key);
  if (!data.job_id) return false;

  const ck = `${board}:${jobId}`;
  const pipe = r.pipeline();
  if (data.status) pipe.srem(K.jobStatusIdx(data.status), ck);
  if (data.tags) {
    for (const tag of data.tags.split(",")) {
      pipe.srem(K.tagIdx(tag), ck);
    }
  }
  pipe.srem(K.boardJobsIdx(board), jobId);
  pipe.del(key);
  await execPipe(pipe);
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
  const ck = `${board}:${jobId}`;
  const pipe = r.pipeline();
  pipe.hset(key, { status: newStatus, updated_at: now });
  if (oldStatus) pipe.srem(K.jobStatusIdx(oldStatus), ck);
  pipe.sadd(K.jobStatusIdx(newStatus), ck);
  await execPipe(pipe);

  return {
    ...(data as unknown as Job),
    tags: data.tags ? data.tags.split(",") : [],
    status: newStatus,
    updated_at: now,
  };
}

export async function getJob(r: Redis, board: string, jobId: string): Promise<Job | null> {
  const data = await r.hgetall(K.job(board, jobId));
  if (!data.job_id) return null;
  return {
    ...(data as unknown as Job),
    tags: data.tags ? data.tags.split(",") : [],
  };
}

function parseJobHash(data: Record<string, string>): Job | null {
  if (!data.job_id) return null;
  return {
    ...(data as unknown as Job),
    tags: data.tags ? data.tags.split(",") : [],
  };
}

export async function listJobs(r: Redis, opts?: { board?: string; status?: string; tag?: string }): Promise<Job[]> {
  const sets: string[] = [];

  if (opts?.board) sets.push(K.boardJobsIdx(opts.board));
  if (opts?.status) sets.push(K.jobStatusIdx(opts.status));
  if (opts?.tag) sets.push(K.tagIdx(opts.tag));

  let compositeKeys: string[];

  if (sets.length === 0) {
    // All jobs from all boards
    const boardIds = await r.smembers(K.boardsIdx());
    compositeKeys = [];
    for (const bid of boardIds) {
      const jids = await r.smembers(K.boardJobsIdx(bid));
      compositeKeys.push(...jids.map((jid) => `${bid}:${jid}`));
    }
  } else if (opts?.board && sets.length === 1) {
    // Board-only filter: board index stores bare job_ids, need to prefix
    const jobIds = await r.smembers(K.boardJobsIdx(opts.board));
    compositeKeys = jobIds.map((jid) => `${opts.board}:${jid}`);
  } else if (opts?.board) {
    // Board + other filters: intersect, but board index has bare ids
    const boardJobIds = await r.smembers(K.boardJobsIdx(opts.board));
    const boardCKs = new Set(boardJobIds.map((jid) => `${opts.board}:${jid}`));
    const otherSets = sets.filter((s) => s !== K.boardJobsIdx(opts.board!));
    if (otherSets.length === 1) {
      const members = await r.smembers(otherSets[0]);
      compositeKeys = members.filter((ck) => boardCKs.has(ck));
    } else {
      const members = await r.sinter(...otherSets);
      compositeKeys = members.filter((ck) => boardCKs.has(ck));
    }
  } else if (sets.length === 1) {
    compositeKeys = await r.smembers(sets[0]);
  } else {
    compositeKeys = await r.sinter(...sets);
  }

  const jobs = await Promise.all(
    compositeKeys.map(async (ck) => {
      const [board, jobId] = ck.split(":");
      const data = await r.hgetall(K.job(board, jobId));
      return parseJobHash(data);
    })
  );
  return jobs.filter((j): j is Job => j !== null);
}

/**
 * Retrieve jobs matching a user's interest tags.
 * Returns discovered jobs where at least one job tag overlaps with user tags.
 */
export async function listJobsForUser(r: Redis, userId: string, opts?: { board?: string; status?: string }): Promise<Job[]> {
  const user = await getUser(r, userId);
  if (!user || user.tags.length === 0) return [];

  const status = opts?.status || "discovered";

  // Union all tag sets the user is interested in
  const tagSets = user.tags.map((t) => K.tagIdx(t));
  let candidateKeys: string[];
  if (tagSets.length === 1) {
    candidateKeys = await r.smembers(tagSets[0]);
  } else {
    candidateKeys = await r.sunion(...tagSets);
  }

  // Intersect with status
  const statusMembers = await r.smembers(K.jobStatusIdx(status));
  const statusSet = new Set(statusMembers);
  let filtered = candidateKeys.filter((ck) => statusSet.has(ck));

  // Optionally filter by board
  if (opts?.board) {
    filtered = filtered.filter((ck) => ck.startsWith(`${opts.board}:`));
  }

  const jobs = await Promise.all(
    filtered.map(async (ck) => {
      const [board, jobId] = ck.split(":");
      const data = await r.hgetall(K.job(board, jobId));
      return parseJobHash(data);
    })
  );
  return jobs.filter((j): j is Job => j !== null);
}

/* ══════════════════════ JobRuns ══════════════════════ */

const LOCK_TTL_SECONDS = 300; // 5 min — auto-expire if agent crashes
const APPLICABLE_STATUSES = new Set<Job["status"]>(["discovered", "queued"]);

/**
 * Create a run with SETNX-based locking to prevent duplicate applications.
 *
 * Flow:
 *   1. SETNX lock:apply:{board}:{job_id} → fail? return { error, code: 409 }
 *   2. Verify job exists and is in an applicable status
 *   3. Create the run hash + index entries
 *   4. Transition job from "discovered" → "queued"
 *
 * @returns { run } on success, or { error, code } on conflict/bad state
 */
export async function createRun(
  r: Redis,
  run: Omit<JobRun, "started_at" | "completed_at" | "error" | "status" | "artifacts">,
  artifacts?: RunArtifacts,
): Promise<{ run: JobRun } | { error: string; code: number }> {
  const lockKey = K.applyLock(run.board, run.job_id);

  // 1. Atomic lock — only one agent can claim this job
  const locked = await r.set(lockKey, run.run_id, "EX", LOCK_TTL_SECONDS, "NX");
  if (!locked) {
    return { error: "Job already has an active application in progress", code: 409 };
  }

  // 2. Check job status
  const job = await getJob(r, run.board, run.job_id);
  if (!job) {
    await r.del(lockKey);
    return { error: "Job not found", code: 404 };
  }
  if (!APPLICABLE_STATUSES.has(job.status)) {
    await r.del(lockKey);
    return { error: `Job is in '${job.status}' status — only discovered/queued jobs can be applied to`, code: 400 };
  }

  // 3. Create the run
  const now = new Date().toISOString();
  const full: JobRun = {
    ...run,
    status: "pending",
    started_at: now,
    completed_at: null,
    error: null,
    artifacts: artifacts || null,
  };
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
    artifacts: JSON.stringify(full.artifacts),
  });
  pipe.sadd(K.jobRunsIdx(run.job_id), run.run_id);
  pipe.sadd(K.runsAll(), run.run_id);
  await execPipe(pipe);

  // 4. Transition job to "queued" if it was "discovered"
  if (job.status === "discovered") {
    await updateJobStatus(r, run.board, run.job_id, "queued");
  }

  return { run: full };
}

/**
 * Update a run's status and optionally merge artifacts.
 *
 * On success: job → "applied", lock deleted.
 * On failure (no other active runs): job → "discovered", lock deleted.
 */
export async function updateRun(
  r: Redis,
  runId: string,
  update: { status: JobRun["status"]; error?: string; artifacts?: RunArtifacts }
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

  // Merge artifacts — append new fields to existing
  if (update.artifacts) {
    const existing: RunArtifacts = data.artifacts ? JSON.parse(data.artifacts) : {};
    const merged = { ...existing, ...update.artifacts };
    if (update.artifacts.answers && existing.answers) {
      merged.answers = { ...existing.answers, ...update.artifacts.answers };
    }
    fields.artifacts = JSON.stringify(merged);
  }

  await r.hset(key, fields);

  const board = data.board;
  const jobId = data.job_id;
  const lockKey = K.applyLock(board, jobId);

  // Auto-transition job status based on run outcome
  if (update.status === "success") {
    await updateJobStatus(r, board, jobId, "applied");
    await r.del(lockKey);
  } else if (update.status === "failed") {
    // Check if any other active runs exist for this job
    const siblingRuns = await listRuns(r, jobId);
    const hasActiveRun = siblingRuns.some(
      (sr) => sr.run_id !== runId && (sr.status === "pending" || sr.status === "submitted")
    );
    if (!hasActiveRun) {
      await updateJobStatus(r, board, jobId, "discovered");
    }
    await r.del(lockKey);
  }

  const updated = await r.hgetall(key);
  return parseRunHash(updated);
}

function parseRunHash(data: Record<string, string>): JobRun | null {
  if (!data.run_id) return null;
  return {
    run_id: data.run_id,
    job_id: data.job_id,
    board: data.board,
    variant_id: data.variant_id,
    status: data.status as JobRun["status"],
    started_at: data.started_at,
    completed_at: data.completed_at || null,
    error: data.error || null,
    artifacts: data.artifacts ? JSON.parse(data.artifacts) : null,
  };
}

export async function listRuns(r: Redis, jobId?: string): Promise<JobRun[]> {
  const runIds = jobId
    ? await r.smembers(K.jobRunsIdx(jobId))
    : await r.smembers(K.runsAll());

  const runs = await Promise.all(
    runIds.map(async (rid) => {
      const data = await r.hgetall(K.run(rid));
      return parseRunHash(data);
    })
  );
  return runs.filter((r): r is JobRun => r !== null);
}

/* ══════════════════════ Users ══════════════════════ */

export async function upsertUser(r: Redis, id: string, resumes: string[], answers: Record<string, string>, tags: string[]): Promise<User> {
  const now = new Date().toISOString();
  const pipe = r.pipeline();
  pipe.hset(K.user(id), {
    id,
    resumes: JSON.stringify(resumes),
    answers: JSON.stringify(answers),
    tags: JSON.stringify(tags),
    updated_at: now,
  });
  pipe.sadd(K.usersIdx(), id);
  await execPipe(pipe);
  return { id, resumes, answers, tags, updated_at: now };
}

export async function getUser(r: Redis, id: string): Promise<User | null> {
  const data = await r.hgetall(K.user(id));
  if (!data.id) return null;
  return {
    id: data.id,
    resumes: JSON.parse(data.resumes || "[]"),
    answers: JSON.parse(data.answers || "{}"),
    tags: JSON.parse(data.tags || "[]"),
    updated_at: data.updated_at,
  };
}

export async function listUsers(r: Redis): Promise<User[]> {
  const ids = await r.smembers(K.usersIdx());
  const users = await Promise.all(ids.map((id) => getUser(r, id)));
  return users.filter((u): u is User => u !== null);
}
