#!/usr/bin/env node
/**
 * batch-apply.mjs — Apply to discovered jobs via the crawler service API.
 *
 * Two modes:
 *   1. Local:  Calls /api/crawler/apply which runs form POST / headless Chrome on the server
 *   2. Remote: Retrieves jobs, then calls /api/crawler/apply for each (serverless apply)
 *
 * Usage:
 *   node scripts/batch-apply.mjs                          # apply to all discovered jobs
 *   node scripts/batch-apply.mjs --board=ramp             # filter by board
 *   node scripts/batch-apply.mjs --board=ramp --limit=5   # limit to 5 jobs
 *   node scripts/batch-apply.mjs --tag=engineering        # filter by tag
 *   node scripts/batch-apply.mjs --dry-run                # show what would be applied
 *   node scripts/batch-apply.mjs --mode=browser           # force browser mode
 *
 * Env:
 *   API_URL        — crawler service URL (default: https://allocation-crawler-service.netlify.app)
 *   RESUME_PATH    — path to resume PDF (optional, for browser file upload)
 */

const API_URL = process.env.API_URL || "https://allocation-crawler-service.netlify.app";

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace("--", "").split("=");
      return [k, v || "true"];
    })
);

const BOARD = args.board || undefined;
const TAG = args.tag || undefined;
const LIMIT = parseInt(args.limit || "0", 10);
const DRY_RUN = args["dry-run"] === "true";
const MODE = args.mode || "auto"; // form_post | browser | auto

// Candidate profile — edit this or set CANDIDATE_JSON env
const CANDIDATE = {
  firstName: "Jason",
  lastName: "Bian",
  email: "jason.bian64@gmail.com",
  phone: "+1-734-730-6569",
  authorizedToWork: true,
  requiresSponsorship: false,
  veteranStatus: false,
  resumePath: process.env.RESUME_PATH || undefined,
  resumeText: `JASON BIAN
New York, New York 10018 | +1 734-730-6569 | jason.bian64@gmail.com | linkedin.com/in/jasonzb
PROFESSIONAL EXPERIENCE
AMAZON.COM — Data Engineer II (2021 – Present)
• High Cardinality Forecast Generation in Java, Python and Spark
• RL-based development for inventory purchasing actions
• Reduced latency of ~550 different input signals, shortening end-to-end pipeline runtime 6.4x
TECH SKILLS
Programming: Java, Python, SQL, Spark, Scala, TypeScript, C++
Frameworks: Apache, AWS, Databricks, CloudFormation
EDUCATION
B.S.E Industrial and Operations Engineering, University of Michigan Ann Arbor — Major GPA 3.83`,
};

async function apiGet(path) {
  const res = await fetch(`${API_URL}${path}`, { headers: { Accept: "application/json" } });
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log(`\nCrawler API: ${API_URL}`);
  console.log(`Mode: ${MODE} | Board: ${BOARD || "all"} | Tag: ${TAG || "any"} | Limit: ${LIMIT || "none"}\n`);

  // 1. Retrieve discovered jobs
  const params = new URLSearchParams({ status: "discovered" });
  if (BOARD) params.set("board", BOARD);
  if (TAG) params.set("tag", TAG);

  const jobsData = await apiGet(`/api/crawler/jobs?${params}`);
  let jobs = jobsData.jobs || [];
  console.log(`Found ${jobs.length} discovered jobs`);

  if (LIMIT > 0) jobs = jobs.slice(0, LIMIT);

  if (jobs.length === 0) {
    console.log("No jobs to apply to.\n");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDry run — would apply to:\n");
    for (const job of jobs) {
      console.log(`  [${job.board}] ${job.title} (${job.job_id})`);
      console.log(`    ${job.url}`);
      console.log(`    Tags: ${(job.tags || []).join(", ") || "none"}`);
    }
    console.log(`\nTotal: ${jobs.length} jobs. Pass without --dry-run to apply.\n`);
    return;
  }

  // 2. Apply to each job via the apply endpoint
  const results = { success: 0, failed: 0, skipped: 0 };

  for (const job of jobs) {
    process.stdout.write(`  [${job.board}] ${job.title}... `);

    const { status, data } = await apiPost("/api/crawler/apply", {
      board: job.board,
      job_id: job.job_id,
      variant_id: "resume-default",
      mode: MODE,
      candidate: CANDIDATE,
    });

    if (status === 409) {
      console.log("SKIP (already claimed)");
      results.skipped++;
    } else if (status === 400) {
      console.log(`SKIP (${data.error})`);
      results.skipped++;
    } else if (data.success) {
      console.log(`PASS (${data.method})`);
      if (data.confirmation_url) console.log(`    Confirmation: ${data.confirmation_url}`);
      results.success++;
    } else {
      console.log(`FAIL (${data.message?.substring(0, 80)})`);
      results.failed++;
    }

    // Delay between applications
    if (jobs.indexOf(job) < jobs.length - 1) {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  console.log(`\nResults: ${results.success} applied | ${results.failed} failed | ${results.skipped} skipped\n`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
