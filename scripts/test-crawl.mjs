#!/usr/bin/env node
/**
 * test-crawl.mjs — Fetch jobs from ATS APIs and push to crawler service.
 *
 * Usage:
 *   node scripts/test-crawl.mjs                       # fetch only (dry run)
 *   node scripts/test-crawl.mjs --push                # fetch + POST to API
 *   API_URL=http://localhost:8888 node scripts/test-crawl.mjs --push
 */

const API_URL = process.env.API_URL || "https://allocation-crawler-service.netlify.app";
const PUSH = process.argv.includes("--push");

/* ── Board definitions (subset for testing) ── */
const BOARDS = [
  { token: "vercel",   name: "Vercel",   ats: "greenhouse" },
  { token: "coinbase",  name: "Coinbase",  ats: "greenhouse" },
  { token: "ramp",     name: "Ramp",     ats: "ashby" },
];

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

/* ── Main ── */

async function main() {
  console.log(`\n🔍 Crawling ${BOARDS.length} boards...\n`);

  const allJobs = [];

  for (const board of BOARDS) {
    process.stdout.write(`  ${board.name} (${board.ats})... `);
    try {
      const jobs = await fetchers[board.ats](board.token);
      console.log(`${jobs.length} jobs`);
      allJobs.push({ board, jobs });

      // Show first 3 jobs
      for (const j of jobs.slice(0, 3)) {
        console.log(`    • ${j.title} — ${j.location} / ${j.department}`);
      }
      if (jobs.length > 3) console.log(`    ... and ${jobs.length - 3} more`);
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
    }
  }

  const totalJobs = allJobs.reduce((s, b) => s + b.jobs.length, 0);
  console.log(`\n📊 Total: ${totalJobs} jobs from ${allJobs.length} boards\n`);

  if (!PUSH) {
    console.log("Dry run — pass --push to POST jobs to the crawler API.\n");
    return;
  }

  /* ── Push to API ── */
  console.log(`📤 Pushing to ${API_URL}...\n`);

  // 1. Register boards
  for (const { board } of allJobs) {
    const { status, data } = await apiPost("/api/crawler/boards", {
      id: board.token,
      company: board.name,
    });
    console.log(`  Board ${board.token}: ${status} — ${data.id || data.error}`);
  }

  // 2. Bulk-add jobs (limit to 20 per board for testing)
  for (const { board, jobs } of allJobs) {
    const batch = jobs.slice(0, 20).map((j) => ({ ...j, board: board.token }));
    const { status, data } = await apiPost("/api/crawler/jobs", { jobs: batch });
    console.log(`  Jobs ${board.token}: ${status} — ${data.count ?? data.error} jobs added`);
  }

  // 3. Verify via GET
  console.log("\n📋 Verification:\n");
  const { data: boardsData } = await apiGet("/api/crawler/boards");
  console.log(`  Boards: ${boardsData.count ?? boardsData.error}`);

  const { data: jobsData } = await apiGet("/api/crawler/jobs");
  console.log(`  Total jobs: ${jobsData.count ?? jobsData.error}`);

  for (const { board } of allJobs) {
    const { data } = await apiGet(`/api/crawler/jobs?board=${board.token}`);
    console.log(`  ${board.token}: ${data.count ?? data.error} jobs`);
  }

  // 4. Test tag filtering
  const { data: quantJobs } = await apiGet("/api/crawler/jobs?tag=engineering");
  console.log(`  Tagged 'engineering': ${quantJobs.count ?? quantJobs.error} jobs`);

  console.log("\n✅ Done!\n");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
