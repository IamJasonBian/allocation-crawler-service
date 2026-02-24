#!/usr/bin/env node
/**
 * test-crawl.mjs — Fetch jobs from ATS APIs and push to crawler service.
 *
 * Usage:
 *   node scripts/test-crawl.mjs                       # fetch only (dry run)
 *   node scripts/test-crawl.mjs --push                # fetch + POST to API
 *   node scripts/test-crawl.mjs --seed                # register boards from config/boards.json
 *   API_URL=http://localhost:8888 node scripts/test-crawl.mjs --push
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const API_URL = process.env.API_URL || "https://allocation-crawler-service.netlify.app";
const PUSH = process.argv.includes("--push");
const SEED = process.argv.includes("--seed");

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ── ATS fetchers ── */

async function fetchGreenhouse(token) {
  const res = await fetch(
    `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((j) => ({
    job_id: String(j.id),
    title: j.title,
    url: j.absolute_url,
    location: j.location?.name || "Unknown",
    department: j.departments?.[0]?.name || "General",
  }));
}

async function fetchLever(token) {
  const res = await fetch(
    `https://api.lever.co/v0/postings/${token}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data || []).map((j) => ({
    job_id: j.id,
    title: j.text,
    url: j.hostedUrl,
    location: j.categories?.location || "Unknown",
    department: j.categories?.department || j.categories?.team || "General",
  }));
}

async function fetchAshby(token) {
  const res = await fetch(
    `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.jobs || []).map((j) => ({
    job_id: j.id,
    title: j.title,
    url: j.jobUrl,
    location: j.location || "Unknown",
    department: j.department || j.team || "General",
  }));
}

const fetchers = { greenhouse: fetchGreenhouse, lever: fetchLever, ashby: fetchAshby };

/* ── API helpers ── */

async function apiPost(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Accept: "application/json" },
  });
  return { status: res.status, data: await res.json() };
}

/* ── Seed boards from config ── */

async function seedBoards() {
  const configPath = resolve(__dirname, "../config/boards.json");
  const boards = JSON.parse(readFileSync(configPath, "utf-8"));
  console.log(`\nSeeding ${boards.length} boards to ${API_URL}...\n`);

  for (const board of boards) {
    const { status, data } = await apiPost("/api/crawler/boards", board);
    console.log(`  ${board.id} (${board.ats}): ${status} — ${data.id || data.error}`);
  }
  console.log("\nDone!\n");
}

/* ── Fetch boards from API ── */

async function getBoardsFromAPI() {
  const { status, data } = await apiGet("/api/crawler/boards");
  if (status !== 200 || !data.boards) {
    console.error(`Failed to fetch boards: ${status}`);
    return [];
  }
  return data.boards.filter((b) => b.ats);
}

/* ── Main ── */

async function main() {
  if (SEED) {
    await seedBoards();
    return;
  }

  // Read boards from API
  const boards = await getBoardsFromAPI();
  if (boards.length === 0) {
    console.log("No boards registered. Run with --seed first to register boards from config/boards.json.");
    return;
  }

  console.log(`\nCrawling ${boards.length} boards...\n`);

  const allJobs = [];

  for (const board of boards) {
    process.stdout.write(`  ${board.company || board.id} (${board.ats})... `);
    try {
      const fetcher = fetchers[board.ats];
      if (!fetcher) {
        console.log(`SKIP (unknown ats: ${board.ats})`);
        continue;
      }
      const jobs = await fetcher(board.id);
      console.log(`${jobs.length} jobs`);
      allJobs.push({ board, jobs });

      for (const j of jobs.slice(0, 3)) {
        console.log(`    - ${j.title} — ${j.location} / ${j.department}`);
      }
      if (jobs.length > 3) console.log(`    ... and ${jobs.length - 3} more`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  const totalJobs = allJobs.reduce((s, b) => s + b.jobs.length, 0);
  console.log(`\nTotal: ${totalJobs} jobs from ${allJobs.length} boards\n`);

  if (!PUSH) {
    console.log("Dry run — pass --push to POST jobs to the crawler API.\n");
    return;
  }

  /* ── Push to API ── */
  console.log(`Pushing to ${API_URL}...\n`);

  for (const { board, jobs } of allJobs) {
    const batch = jobs.map((j) => ({ ...j, board: board.id }));
    const { status, data } = await apiPost("/api/crawler/jobs", { jobs: batch });
    console.log(`  ${board.id}: ${status} — ${data.count ?? data.error} new jobs added`);
  }

  // Verify
  console.log("\nVerification:\n");
  const { data: boardsData } = await apiGet("/api/crawler/boards");
  console.log(`  Boards: ${boardsData.count ?? boardsData.error}`);

  const { data: jobsData } = await apiGet("/api/crawler/jobs");
  console.log(`  Total jobs: ${jobsData.count ?? jobsData.error}`);

  for (const { board } of allJobs) {
    const { data } = await apiGet(`/api/crawler/jobs?board=${board.id}`);
    console.log(`  ${board.id}: ${data.count ?? data.error} jobs`);
  }

  console.log("\nDone!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
