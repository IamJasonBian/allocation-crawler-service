#!/usr/bin/env node
/**
 * ops.mjs — Operations toolkit for managing the crawler service.
 *
 * Usage:
 *   node scripts/ops.mjs <command> [options]
 *
 * Commands:
 *   migrate         Backfill new fields (content_hash, last_seen_at) on existing jobs
 *   backfill-applied  Fix jobs that have successful runs with confirmation but weren't marked applied
 *   audit           Show verified vs unverified applied jobs
 *   orphan-runs     Find runs whose parent job no longer exists
 *   stale-locks     List and optionally clear expired apply locks
 *   status-report   Summary of boards, jobs by status, runs by status
 *   expire-missing  Mark jobs not seen in N days as expired (default: 7)
 *   fix-indexes     Rebuild all Redis indexes from the source-of-truth hashes
 *   nuke-board      Remove a board and ALL its data (jobs, runs, indexes)
 *
 * Options:
 *   --dry-run       Show what would change without writing (default for destructive ops)
 *   --apply         Actually write changes
 *   --board <id>    Scope to a specific board
 *   --days <n>      For expire-missing: days threshold (default 7)
 *
 * Environment:
 *   API_URL         Base URL (default: https://allocation-crawler-service.netlify.app)
 */

const API_URL = process.env.API_URL || "https://allocation-crawler-service.netlify.app";
const args = process.argv.slice(2);
const command = args[0];
const DRY_RUN = !args.includes("--apply");
const BOARD_FILTER = getArg("--board");
const DAYS = parseInt(getArg("--days") || "7", 10);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

/* ── API helpers ── */

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_URL}${path}`, opts);
  return { status: res.status, data: await res.json() };
}

const get = (path) => api("GET", path);
const post = (path, body) => api("POST", path, body);
const patch = (path, body) => api("PATCH", path, body);

/* ══════════════════════ Commands ══════════════════════ */

async function migrate() {
  console.log("=== Migrate: backfill content_hash + last_seen_at ===\n");
  console.log("These fields are populated on new jobs and on re-crawl.");
  console.log("For existing jobs, we trigger a crawl which will bump last_seen_at");
  console.log("and compute content_hash for all existing jobs.\n");

  if (DRY_RUN) {
    console.log("[dry-run] Would trigger crawl to backfill fields.");
    console.log("Run with --apply to execute.\n");
    return;
  }

  console.log("Triggering crawl...");
  const { status, data } = await post("/api/crawler/jobs", { action: "crawl" });
  if (status === 200) {
    console.log(`Crawl complete: ${data.total_new} new, ${data.total_updated ?? 0} updated`);
    for (const [board, info] of Object.entries(data.boards || {})) {
      const summary = typeof info === "object" ? `new=${info.new}, updated=${info.updated}` : `result=${info}`;
      console.log(`  ${board}: ${summary}`);
    }
  } else {
    console.error(`Crawl failed (${status}):`, data);
  }
}

async function backfillApplied() {
  console.log("=== Backfill Applied: fix jobs with confirmed runs ===\n");

  // Get all runs
  const { data: runsData } = await get("/api/crawler/jobs?runs_for=");
  const runs = runsData.runs || [];
  console.log(`Total runs: ${runs.length}`);

  const successRuns = runs.filter((r) => r.status === "success");
  console.log(`Successful runs: ${successRuns.length}\n`);

  for (const run of successRuns) {
    const hasConfirmation = run.artifacts?.confirmation_url;
    const { data: job } = await get(`/api/crawler/jobs?board=${run.board}&id=${run.job_id}`);

    if (!job || job.error) {
      console.log(`  [orphan] run=${run.run_id} → job ${run.board}:${run.job_id} not found`);
      continue;
    }

    console.log(`  run=${run.run_id} board=${run.board} job=${run.job_id}`);
    console.log(`    job status: ${job.status}, applied_run_id: ${job.applied_run_id || "none"}`);
    console.log(`    confirmation_url: ${hasConfirmation || "NONE"}`);

    if (hasConfirmation && job.status !== "applied") {
      if (DRY_RUN) {
        console.log(`    [dry-run] Would mark job as applied with run_id=${run.run_id}`);
      } else {
        // Re-update the run to trigger the applied transition
        const { status, data } = await patch("/api/crawler/jobs", {
          run_id: run.run_id,
          status: "success",
          artifacts: run.artifacts,
        });
        console.log(`    → patched: ${status} — job now ${data?.status || "unknown"}`);
      }
    } else if (!hasConfirmation && job.status === "applied") {
      console.log(`    [WARNING] Job is "applied" but run has no confirmation_url!`);
      if (!DRY_RUN) {
        const { status } = await patch("/api/crawler/jobs", {
          board: run.board,
          job_id: run.job_id,
          status: "queued",
        });
        console.log(`    → reverted to "queued": ${status}`);
      } else {
        console.log(`    [dry-run] Would revert job to "queued"`);
      }
    } else {
      console.log(`    ✓ consistent`);
    }
  }
  console.log();
}

async function audit() {
  console.log("=== Audit: verified vs unverified applied jobs ===\n");

  const body = { action: "check" };
  if (BOARD_FILTER) body.board = BOARD_FILTER;

  const { data } = await post("/api/crawler/jobs", body);

  console.log(`Verified: ${data.verified_count || 0}`);
  for (const v of data.verified || []) {
    console.log(`  ✓ ${v.board}/${v.job_id} — ${v.title}`);
    console.log(`    applied: ${v.applied_at}, run: ${v.applied_run_id}`);
    console.log(`    confirmation: ${v.confirmation_url}`);
  }

  console.log(`\nUnverified: ${data.unverified_count || 0}`);
  for (const u of data.unverified || []) {
    console.log(`  ✗ ${u.board}/${u.job_id} — ${u.title}`);
    console.log(`    applied: ${u.applied_at}, run: ${u.run_id || "none"} (${u.run_status || "n/a"})`);
  }
  console.log();
}

async function orphanRuns() {
  console.log("=== Orphan Runs: runs with missing parent jobs ===\n");

  const { data: runsData } = await get("/api/crawler/jobs?runs_for=");
  const runs = runsData.runs || [];
  let orphanCount = 0;

  for (const run of runs) {
    const { data: job } = await get(`/api/crawler/jobs?board=${run.board}&id=${run.job_id}`);
    if (!job || job.error) {
      orphanCount++;
      console.log(`  orphan: run=${run.run_id} → ${run.board}:${run.job_id} (${run.status})`);
      if (run.artifacts?.confirmation_url) {
        console.log(`    ⚠ has confirmation_url: ${run.artifacts.confirmation_url}`);
      }
    }
  }

  console.log(`\n${orphanCount} orphan run(s) found out of ${runs.length} total.\n`);
}

async function statusReport() {
  console.log("=== Status Report ===\n");

  const { data: boardsData } = await get("/api/crawler/boards");
  const boards = boardsData.boards || [];
  const withAts = boards.filter((b) => b.ats);
  console.log(`Boards: ${boards.length} total, ${withAts.length} with ATS configured`);
  console.log(`  ATS breakdown: ${countBy(withAts, "ats")}\n`);

  const statuses = ["discovered", "queued", "applied", "rejected", "expired"];
  let totalJobs = 0;
  for (const status of statuses) {
    const { data } = await get(`/api/crawler/jobs?status=${status}`);
    const count = data.count || 0;
    totalJobs += count;
    if (count > 0) {
      console.log(`Jobs [${status}]: ${count}`);
      if (BOARD_FILTER) {
        const filtered = (data.jobs || []).filter((j) => j.board === BOARD_FILTER);
        console.log(`  (${BOARD_FILTER}: ${filtered.length})`);
      }
    }
  }
  console.log(`Jobs total: ${totalJobs}\n`);

  const { data: runsData } = await get("/api/crawler/jobs?runs_for=");
  const runs = runsData.runs || [];
  const runStatuses = { pending: 0, submitted: 0, success: 0, failed: 0 };
  for (const run of runs) {
    runStatuses[run.status] = (runStatuses[run.status] || 0) + 1;
  }
  console.log(`Runs: ${runs.length} total`);
  for (const [s, c] of Object.entries(runStatuses)) {
    if (c > 0) console.log(`  [${s}]: ${c}`);
  }

  const withConfirmation = runs.filter((r) => r.artifacts?.confirmation_url);
  console.log(`  with confirmation_url: ${withConfirmation.length}`);
  console.log();
}

async function expireMissing() {
  console.log(`=== Expire Missing: jobs not seen in ${DAYS}+ days ===\n`);

  const { data } = await get("/api/crawler/jobs?status=discovered");
  const jobs = data.jobs || [];
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  const stale = jobs.filter((j) => {
    const lastSeen = j.last_seen_at || j.updated_at || j.discovered_at;
    return lastSeen < cutoff;
  });

  console.log(`Discovered jobs: ${jobs.length}`);
  console.log(`Stale (last seen before ${cutoff.slice(0, 10)}): ${stale.length}\n`);

  if (BOARD_FILTER) {
    const filtered = stale.filter((j) => j.board === BOARD_FILTER);
    console.log(`  (filtered to ${BOARD_FILTER}: ${filtered.length})`);
  }

  for (const job of stale.slice(0, 20)) {
    const lastSeen = job.last_seen_at || job.updated_at;
    console.log(`  ${job.board}/${job.job_id} — ${job.title} (last seen: ${lastSeen?.slice(0, 10) || "never"})`);
    if (!DRY_RUN) {
      await patch("/api/crawler/jobs", { board: job.board, job_id: job.job_id, status: "expired" });
    }
  }
  if (stale.length > 20) console.log(`  ... and ${stale.length - 20} more`);

  if (DRY_RUN && stale.length > 0) {
    console.log(`\n[dry-run] Would mark ${stale.length} jobs as expired. Run with --apply to execute.`);
  } else if (stale.length > 0) {
    console.log(`\nMarked ${stale.length} jobs as expired.`);
  }
  console.log();
}

async function fixIndexes() {
  console.log("=== Fix Indexes: rebuild all status + tag indexes from job hashes ===\n");
  console.log("Clears all idx:job_status:* and idx:tag:* sets, then walks every");
  console.log("job hash and re-adds the correct index entries.\n");

  if (DRY_RUN) {
    console.log("[dry-run] Would reconcile all indexes. Run with --apply to execute.\n");
    return;
  }

  const { status, data } = await post("/api/crawler/jobs", { action: "reconcile" });
  if (status === 200) {
    console.log(`Jobs scanned: ${data.jobs_scanned}`);
    console.log(`Orphan index entries removed: ${data.orphan_index_entries_removed}`);
    console.log(`\nStatus index rebuilt:`);
    for (const [s, c] of Object.entries(data.status_index_rebuilt || {})) {
      console.log(`  ${s}: ${c}`);
    }
    console.log(`\nTag index rebuilt:`);
    for (const [t, c] of Object.entries(data.tag_index_rebuilt || {})) {
      console.log(`  ${t}: ${c}`);
    }
  } else {
    console.error(`Reconcile failed (${status}):`, data);
  }
  console.log();
}

async function nukeBoard() {
  if (!BOARD_FILTER) {
    console.error("Usage: ops.mjs nuke-board --board <id> [--apply]");
    process.exit(1);
  }

  console.log(`=== Nuke Board: ${BOARD_FILTER} ===\n`);

  const { data: board } = await get(`/api/crawler/boards?id=${BOARD_FILTER}`);
  if (board.error) {
    console.error(`Board not found: ${BOARD_FILTER}`);
    return;
  }
  console.log(`Board: ${board.company} (${board.ats || "no ats"})`);

  const { data: jobsData } = await get(`/api/crawler/jobs?board=${BOARD_FILTER}`);
  console.log(`Jobs: ${jobsData.count || 0}`);

  // Check for runs
  const jobs = jobsData.jobs || [];
  let runCount = 0;
  for (const job of jobs) {
    const { data: runsData } = await get(`/api/crawler/jobs?runs_for=${job.job_id}`);
    runCount += (runsData.runs || []).length;
  }
  console.log(`Runs: ${runCount}\n`);

  if (DRY_RUN) {
    console.log(`[dry-run] Would delete board "${BOARD_FILTER}", ${jobsData.count || 0} jobs, and ${runCount} runs.`);
    console.log("Run with --apply to execute.\n");
    return;
  }

  const { status, data } = await api("DELETE", "/api/crawler/boards", { id: BOARD_FILTER });
  console.log(`Delete: ${status} — ${JSON.stringify(data)}\n`);
}

/* ── Helpers ── */

function countBy(arr, key) {
  const counts = {};
  for (const item of arr) {
    const v = item[key] || "none";
    counts[v] = (counts[v] || 0) + 1;
  }
  return Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
}

/* ── Router ── */

const commands = {
  migrate,
  "backfill-applied": backfillApplied,
  audit,
  "orphan-runs": orphanRuns,
  "stale-locks": async () => {
    console.log("=== Stale Locks ===\n");
    console.log("Lock keys (lock:apply:*) auto-expire after 300s via Redis TTL.");
    console.log("If a lock is stuck, it means the agent crashed <5 min ago.");
    console.log("Wait for TTL expiry, or use Redis CLI: DEL lock:apply:<board>:<job_id>\n");
  },
  "status-report": statusReport,
  "expire-missing": expireMissing,
  "fix-indexes": fixIndexes,
  "nuke-board": nukeBoard,
};

async function main() {
  if (!command || command === "--help" || !commands[command]) {
    console.log("Usage: node scripts/ops.mjs <command> [--apply] [--board <id>] [--days <n>]\n");
    console.log("Commands:");
    console.log("  migrate           Backfill content_hash + last_seen_at via crawl");
    console.log("  backfill-applied  Fix jobs that have confirmed runs but aren't marked applied");
    console.log("  audit             Show verified vs unverified applied jobs");
    console.log("  orphan-runs       Find runs whose parent job is missing");
    console.log("  stale-locks       Info about apply locks");
    console.log("  status-report     Board/job/run summary");
    console.log("  expire-missing    Mark jobs not seen in N days as expired");
    console.log("  fix-indexes       Rebuild indexes via full re-crawl");
    console.log("  nuke-board        Delete a board and all its data");
    console.log("\nOptions:");
    console.log("  --apply           Write changes (default is dry-run)");
    console.log("  --board <id>      Scope to a specific board");
    console.log("  --days <n>        Days threshold for expire-missing (default: 7)");
    console.log(`\nTarget: ${API_URL}`);
    console.log("Set API_URL env to override.\n");
    if (command && !commands[command]) {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
    return;
  }

  if (DRY_RUN && ["migrate", "backfill-applied", "expire-missing", "fix-indexes", "nuke-board"].includes(command)) {
    console.log(`[DRY RUN] Pass --apply to write changes.\n`);
  }

  await commands[command]();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
