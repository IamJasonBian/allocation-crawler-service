import type Redis from "ioredis";
import type { ATSType, Board, Job, JobStatus, Run, RunStatus, RunArtifacts, User, ResumeVariant, Crawl, CrawlStats, FetchedJob } from "./types.js";
import { extractTags } from "./tags.js";
import { createHash } from "crypto";

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
  userEmailIdx: (email: string) => `idx:user_email:${email}`,
  crawl: (crawlId: string) => `crawl_exec:${crawlId}`,
  crawlsAll: () => "idx:crawls",
};

export { K };

/** Content hash for change detection — same algorithm as notification service. */
function contentHash(title: string, location: string, department: string): string {
  return createHash("sha256").update(`${title}|${location}|${department}`).digest("hex").slice(0, 16);
}

/* ══════════════════════ Boards ══════════════════════ */

export async function addBoard(r: Redis, id: string, company: string, ats: ATSType, career_page_url = ""): Promise<Board> {
  const board: Board = { id, company, ats, career_page_url, created_at: new Date().toISOString() };
  const pipe = r.pipeline();
  pipe.hset(K.board(id), { id, company, ats, career_page_url, created_at: board.created_at });
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
      return data.id ? parseBoardHash(data) : null;
    })
  );
  return boards.filter((b): b is Board => b !== null);
}

export async function getBoard(r: Redis, id: string): Promise<Board | null> {
  const data = await r.hgetall(K.board(id));
  return data.id ? parseBoardHash(data) : null;
}

function parseBoardHash(data: Record<string, string>): Board {
  return {
    id: data.id,
    company: data.company,
    ats: (data.ats || "greenhouse") as ATSType,
    career_page_url: data.career_page_url || "",
    created_at: data.created_at,
  };
}

/* ══════════════════════ Jobs ══════════════════════ */

type NewJobInput = FetchedJob & { board: string };

export async function addJob(r: Redis, job: NewJobInput): Promise<Job> {
  const now = new Date().toISOString();
  const tags = extractTags(job.title, job.department);
  const hash = contentHash(job.title, job.location, job.department);
  const full: Job = {
    ...job, tags, content_hash: hash,
    status: "discovered",
    discovered_at: now, updated_at: now, last_seen_at: now,
    applied_at: null, applied_run_id: null,
  };
  const ck = `${job.board}:${job.job_id}`;
  const pipe = r.pipeline();
  pipe.hset(K.job(job.board, job.job_id), jobToRedis(full));
  pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
  pipe.sadd(K.jobStatusIdx("discovered"), ck);
  for (const tag of tags) {
    pipe.sadd(K.tagIdx(tag), ck);
  }
  await execPipe(pipe);
  return full;
}

/**
 * Bulk-add jobs from a crawl. New jobs are inserted as "discovered".
 * Existing jobs get their last_seen_at bumped and content_hash checked for updates.
 * Returns only newly inserted jobs.
 */
export async function addJobsBulk(r: Redis, jobs: NewJobInput[]): Promise<{ new: Job[]; updated: number }> {
  if (jobs.length === 0) return { new: [], updated: 0 };

  const existChecks = await Promise.all(
    jobs.map((j) => r.exists(K.job(j.board, j.job_id)))
  );

  const now = new Date().toISOString();
  const newResults: Job[] = [];
  let updatedCount = 0;
  const pipe = r.pipeline();

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const exists = existChecks[i];

    if (!exists) {
      // New job
      const tags = extractTags(job.title, job.department);
      const hash = contentHash(job.title, job.location, job.department);
      const full: Job = {
        ...job, tags, content_hash: hash,
        status: "discovered",
        discovered_at: now, updated_at: now, last_seen_at: now,
        applied_at: null, applied_run_id: null,
      };
      const ck = `${job.board}:${job.job_id}`;
      pipe.hset(K.job(job.board, job.job_id), jobToRedis(full));
      pipe.sadd(K.boardJobsIdx(job.board), job.job_id);
      pipe.sadd(K.jobStatusIdx("discovered"), ck);
      for (const tag of tags) {
        pipe.sadd(K.tagIdx(tag), ck);
      }
      newResults.push(full);
    } else {
      // Existing job — bump last_seen_at, check for content changes
      const newHash = contentHash(job.title, job.location, job.department);
      pipe.hset(K.job(job.board, job.job_id), { last_seen_at: now });

      // Queue a content-change check (we'll read current hash after pipe)
      const existing = await r.hget(K.job(job.board, job.job_id), "content_hash");
      if (existing && existing !== newHash) {
        // Content changed — update fields
        const tags = extractTags(job.title, job.department);
        pipe.hset(K.job(job.board, job.job_id), {
          title: job.title,
          url: job.url,
          location: job.location,
          department: job.department,
          tags: tags.join(","),
          content_hash: newHash,
          updated_at: now,
          last_seen_at: now,
        });
        updatedCount++;
      }
    }
  }

  await execPipe(pipe);
  return { new: newResults, updated: updatedCount };
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
  newStatus: JobStatus
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

  return parseJobHash({ ...data, status: newStatus, updated_at: now });
}

export async function getJob(r: Redis, board: string, jobId: string): Promise<Job | null> {
  const data = await r.hgetall(K.job(board, jobId));
  return parseJobHash(data);
}

function jobToRedis(job: Job): Record<string, string> {
  return {
    job_id: job.job_id,
    board: job.board,
    title: job.title,
    url: job.url,
    location: job.location,
    department: job.department,
    tags: job.tags.join(","),
    content_hash: job.content_hash,
    status: job.status,
    discovered_at: job.discovered_at,
    updated_at: job.updated_at,
    last_seen_at: job.last_seen_at,
    applied_at: job.applied_at || "",
    applied_run_id: job.applied_run_id || "",
  };
}

function parseJobHash(data: Record<string, string>): Job | null {
  if (!data.job_id) return null;
  return {
    job_id: data.job_id,
    board: data.board,
    title: data.title,
    url: data.url,
    location: data.location || "",
    department: data.department || "",
    tags: data.tags ? data.tags.split(",") : [],
    content_hash: data.content_hash || "",
    status: (data.status || "discovered") as JobStatus,
    discovered_at: data.discovered_at,
    updated_at: data.updated_at,
    last_seen_at: data.last_seen_at || data.updated_at,
    applied_at: data.applied_at || null,
    applied_run_id: data.applied_run_id || null,
  };
}

export async function listJobs(r: Redis, opts?: { board?: string; status?: string; tag?: string }): Promise<Job[]> {
  const sets: string[] = [];

  if (opts?.board) sets.push(K.boardJobsIdx(opts.board));
  if (opts?.status) sets.push(K.jobStatusIdx(opts.status));
  if (opts?.tag) sets.push(K.tagIdx(opts.tag));

  let compositeKeys: string[];

  if (sets.length === 0) {
    const boardIds = await r.smembers(K.boardsIdx());
    compositeKeys = [];
    for (const bid of boardIds) {
      const jids = await r.smembers(K.boardJobsIdx(bid));
      compositeKeys.push(...jids.map((jid) => `${bid}:${jid}`));
    }
  } else if (opts?.board && sets.length === 1) {
    const jobIds = await r.smembers(K.boardJobsIdx(opts.board));
    compositeKeys = jobIds.map((jid) => `${opts.board}:${jid}`);
  } else if (opts?.board) {
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

  const tagSets = user.tags.map((t) => K.tagIdx(t));
  let candidateKeys: string[];
  if (tagSets.length === 1) {
    candidateKeys = await r.smembers(tagSets[0]);
  } else {
    candidateKeys = await r.sunion(...tagSets);
  }

  const statusMembers = await r.smembers(K.jobStatusIdx(status));
  const statusSet = new Set(statusMembers);
  let filtered = candidateKeys.filter((ck) => statusSet.has(ck));

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

/* ══════════════════════ Runs ══════════════════════ */

const LOCK_TTL_SECONDS = 300; // 5 min — auto-expire if agent crashes
const APPLICABLE_STATUSES = new Set<JobStatus>(["discovered", "queued"]);

/**
 * Create a run with SETNX-based locking to prevent duplicate applications.
 */
export async function createRun(
  r: Redis,
  run: Pick<Run, "run_id" | "job_id" | "board"> & { user_id?: string },
  artifacts?: RunArtifacts,
): Promise<{ run: Run } | { error: string; code: number }> {
  const lockKey = K.applyLock(run.board, run.job_id);

  const locked = await r.set(lockKey, run.run_id, "EX", LOCK_TTL_SECONDS, "NX");
  if (!locked) {
    return { error: "Job already has an active application in progress", code: 409 };
  }

  const job = await getJob(r, run.board, run.job_id);
  if (!job) {
    await r.del(lockKey);
    return { error: "Job not found", code: 404 };
  }
  if (!APPLICABLE_STATUSES.has(job.status)) {
    await r.del(lockKey);
    return { error: `Job is in '${job.status}' status — only discovered/queued jobs can be applied to`, code: 400 };
  }

  const now = new Date().toISOString();
  const full: Run = {
    run_id: run.run_id,
    job_id: run.job_id,
    board: run.board,
    ...(run.user_id ? { user_id: run.user_id } : {}),
    status: "pending",
    started_at: now,
    completed_at: null,
    error: null,
    artifacts: artifacts || null,
  };
  const pipe = r.pipeline();
  pipe.hset(K.run(run.run_id), runToRedis(full));
  pipe.sadd(K.jobRunsIdx(run.job_id), run.run_id);
  pipe.sadd(K.runsAll(), run.run_id);
  await execPipe(pipe);

  if (job.status === "discovered") {
    await updateJobStatus(r, run.board, run.job_id, "queued");
  }

  return { run: full };
}

/**
 * Update a run's status and optionally merge artifacts.
 *
 * On success with confirmation_url: job → "applied", lock deleted.
 * On success without confirmation_url: job stays "queued" (needs verification).
 * On failure (no other active runs): job → "discovered", lock deleted.
 */
export async function updateRun(
  r: Redis,
  runId: string,
  update: { status: RunStatus; error?: string; artifacts?: RunArtifacts }
): Promise<Run | null> {
  const key = K.run(runId);
  const data = await r.hgetall(key);
  if (!data.run_id) return null;

  const now = new Date().toISOString();
  const fields: Record<string, string> = { status: update.status };
  if (update.status === "success" || update.status === "failed") {
    fields.completed_at = now;
  }
  if (update.error) fields.error = update.error;

  // Merge artifacts incrementally
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

  if (update.status === "success") {
    const runData = await r.hgetall(key);
    const artifacts = runData.artifacts ? JSON.parse(runData.artifacts) : {};
    const hasConfirmation = Boolean(artifacts.confirmation_url);

    if (hasConfirmation) {
      await updateJobStatus(r, board, jobId, "applied");
      await r.hset(K.job(board, jobId), { applied_at: now, applied_run_id: runId });
    }
    // Without confirmation_url, job stays queued for manual verification
    await r.del(lockKey);
  } else if (update.status === "failed") {
    const siblingRuns = await listRuns(r, jobId);
    const hasActiveRun = siblingRuns.some(
      (sr) => sr.run_id !== runId && (sr.status === "pending" || sr.status === "submitted")
    );
    // Only revert to "discovered" if the job hasn't already been applied.
    // A prior successful run may have set "applied" — don't overwrite that.
    const currentJob = await getJob(r, board, jobId);
    if (!hasActiveRun && currentJob?.status !== "applied") {
      await updateJobStatus(r, board, jobId, "discovered");
    }
    await r.del(lockKey);
  }

  const updated = await r.hgetall(key);
  return parseRunHash(updated);
}

function runToRedis(run: Run): Record<string, string> {
  return {
    run_id: run.run_id,
    job_id: run.job_id,
    board: run.board,
    user_id: run.user_id || "",
    status: run.status,
    started_at: run.started_at,
    completed_at: run.completed_at || "",
    error: run.error || "",
    artifacts: JSON.stringify(run.artifacts),
  };
}

function parseRunHash(data: Record<string, string>): Run | null {
  if (!data.run_id) return null;
  return {
    run_id: data.run_id,
    job_id: data.job_id,
    board: data.board,
    ...(data.user_id ? { user_id: data.user_id } : {}),
    status: data.status as RunStatus,
    started_at: data.started_at,
    completed_at: data.completed_at || null,
    error: data.error || null,
    artifacts: data.artifacts ? JSON.parse(data.artifacts) : null,
  };
}

export async function listRuns(r: Redis, jobId?: string): Promise<Run[]> {
  const runIds = jobId
    ? await r.smembers(K.jobRunsIdx(jobId))
    : await r.smembers(K.runsAll());

  const runs = await Promise.all(
    runIds.map(async (rid) => {
      const data = await r.hgetall(K.run(rid));
      return parseRunHash(data);
    })
  );
  return runs.filter((r): r is Run => r !== null);
}

/**
 * Audit applied jobs — returns verified (has confirmation_url) vs unverified.
 */
export async function checkApplied(r: Redis, opts?: { board?: string }): Promise<{
  verified: { job: Job; run: Run }[];
  unverified: { job: Job; run: Run | null }[];
}> {
  const appliedJobs = await listJobs(r, { status: "applied", board: opts?.board });
  const verified: { job: Job; run: Run }[] = [];
  const unverified: { job: Job; run: Run | null }[] = [];

  for (const job of appliedJobs) {
    let run: Run | null = null;
    if (job.applied_run_id) {
      const data = await r.hgetall(K.run(job.applied_run_id));
      run = parseRunHash(data);
    }
    if (!run) {
      const runs = await listRuns(r, job.job_id);
      run = runs.find((rn) => rn.status === "success") || null;
    }

    if (run?.artifacts?.confirmation_url) {
      verified.push({ job, run });
    } else {
      unverified.push({ job, run });
    }
  }

  return { verified, unverified };
}

/* ══════════════════════ Index Reconciliation ══════════════════════ */

const ALL_JOB_STATUSES: JobStatus[] = ["discovered", "queued", "applied", "rejected", "expired"];

/**
 * Rebuild all status and tag indexes from the source-of-truth job hashes.
 * Clears every idx:job_status:* and idx:tag:* set, then re-populates
 * from what's actually stored in each job hash.
 *
 * Returns a summary of what was fixed.
 */
export async function reconcileIndexes(r: Redis): Promise<{
  jobs_scanned: number;
  status_index_rebuilt: Record<string, number>;
  tag_index_rebuilt: Record<string, number>;
  orphan_index_entries_removed: number;
}> {
  // 1. Collect all board IDs
  const boardIds = await r.smembers(K.boardsIdx());

  // 2. Clear all status and tag index sets
  const pipe1 = r.pipeline();
  for (const status of ALL_JOB_STATUSES) {
    pipe1.del(K.jobStatusIdx(status));
  }
  // Find all tag index keys via SCAN
  const tagKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await r.scan(cursor, "MATCH", "idx:tag:*", "COUNT", 100);
    cursor = nextCursor;
    tagKeys.push(...keys);
  } while (cursor !== "0");

  for (const key of tagKeys) {
    pipe1.del(key);
  }
  await execPipe(pipe1);

  // 3. Walk every job hash and rebuild indexes
  let jobsScanned = 0;
  let orphanEntries = 0;
  const statusCounts: Record<string, number> = {};
  const tagCounts: Record<string, number> = {};

  for (const boardId of boardIds) {
    const jobIds = await r.smembers(K.boardJobsIdx(boardId));

    const pipe2 = r.pipeline();
    for (const jobId of jobIds) {
      const data = await r.hgetall(K.job(boardId, jobId));
      if (!data.job_id) {
        // Orphan index entry — job hash doesn't exist
        pipe2.srem(K.boardJobsIdx(boardId), jobId);
        orphanEntries++;
        continue;
      }

      jobsScanned++;
      const ck = `${boardId}:${jobId}`;
      const status = data.status || "discovered";

      // Rebuild status index
      pipe2.sadd(K.jobStatusIdx(status), ck);
      statusCounts[status] = (statusCounts[status] || 0) + 1;

      // Rebuild tag indexes
      if (data.tags) {
        for (const tag of data.tags.split(",")) {
          if (tag) {
            pipe2.sadd(K.tagIdx(tag), ck);
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
      }
    }
    await execPipe(pipe2);
  }

  return {
    jobs_scanned: jobsScanned,
    status_index_rebuilt: statusCounts,
    tag_index_rebuilt: tagCounts,
    orphan_index_entries_removed: orphanEntries,
  };
}

/* ══════════════════════ Users ══════════════════════ */

export async function upsertUser(
  r: Redis,
  id: string,
  resumes: ResumeVariant[],
  answers: Record<string, string>,
  tags: string[]
): Promise<User> {
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
    ...(data.email ? { email: data.email } : {}),
    ...(data.google_sub ? { google_sub: data.google_sub } : {}),
    ...(data.display_name ? { display_name: data.display_name } : {}),
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

/** Look up a user by their Google email via the email index. */
export async function getUserByEmail(r: Redis, email: string): Promise<User | null> {
  const userId = await r.get(K.userEmailIdx(email));
  if (!userId) return null;
  return getUser(r, userId);
}

/** Link a Google identity to an existing user and create the email index entry. */
export async function linkUserEmail(
  r: Redis,
  userId: string,
  email: string,
  googleSub: string,
  displayName?: string,
): Promise<void> {
  const fields: Record<string, string> = {
    email,
    google_sub: googleSub,
  };
  if (displayName) fields.display_name = displayName;
  await r.hset(K.user(userId), fields);
  await r.set(K.userEmailIdx(email), userId);
}

/* ══════════════════════ Crawls ══════════════════════ */

export async function createCrawl(
  r: Redis,
  crawl_id: string,
  trigger: Crawl["trigger"],
): Promise<Crawl> {
  const now = new Date().toISOString();
  const crawl: Crawl = {
    crawl_id,
    status: "pending",
    trigger,
    started_at: now,
    completed_at: null,
    error: null,
    stats: null,
  };
  const pipe = r.pipeline();
  pipe.hset(K.crawl(crawl_id), {
    crawl_id,
    status: crawl.status,
    trigger,
    started_at: crawl.started_at,
    completed_at: "",
    error: "",
    stats: "",
  });
  pipe.sadd(K.crawlsAll(), crawl_id);
  await execPipe(pipe);
  return crawl;
}

export async function updateCrawl(
  r: Redis,
  crawl_id: string,
  update: { status?: Crawl["status"]; error?: string; stats?: CrawlStats },
): Promise<Crawl | null> {
  const key = K.crawl(crawl_id);
  const data = await r.hgetall(key);
  if (!data.crawl_id) return null;

  const now = new Date().toISOString();
  const fields: Record<string, string> = {};
  if (update.status) {
    fields.status = update.status;
    if (update.status === "success" || update.status === "failed") {
      fields.completed_at = now;
    }
  }
  if (update.error !== undefined) fields.error = update.error;
  if (update.stats) fields.stats = JSON.stringify(update.stats);

  await r.hset(key, fields);

  const updated = await r.hgetall(key);
  return parseCrawlHash(updated);
}

export async function getCrawl(r: Redis, crawl_id: string): Promise<Crawl | null> {
  const data = await r.hgetall(K.crawl(crawl_id));
  return parseCrawlHash(data);
}

export async function listCrawls(r: Redis): Promise<Crawl[]> {
  const ids = await r.smembers(K.crawlsAll());
  const crawls = await Promise.all(ids.map((id) => getCrawl(r, id)));
  const valid = crawls.filter((c): c is Crawl => c !== null);
  valid.sort((a, b) => (b.started_at > a.started_at ? 1 : b.started_at < a.started_at ? -1 : 0));
  return valid;
}

function parseCrawlHash(data: Record<string, string>): Crawl | null {
  if (!data.crawl_id) return null;
  return {
    crawl_id: data.crawl_id,
    status: data.status as Crawl["status"],
    trigger: data.trigger as Crawl["trigger"],
    started_at: data.started_at,
    completed_at: data.completed_at || null,
    error: data.error || null,
    stats: data.stats ? JSON.parse(data.stats) : null,
  };
}
