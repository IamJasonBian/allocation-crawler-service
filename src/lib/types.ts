/* ── Common Entities ──
 *
 * Shared types across: notification-service, crawler-service, agent.
 * These define a single source of truth for the allocation pipeline.
 *
 * Redis key conventions (unified):
 *   board:{id}                      → Board hash
 *   job:{board}:{job_id}            → Job hash
 *   run:{run_id}                    → Run hash
 *   user:{id}                       → User hash
 *   crawl:{crawl_id}                → Crawl hash
 *   company:{id}                    → Company hash (discovery metadata)
 *   idx:companies                  → Set of company IDs
 *   idx:boards                      → Set of board IDs
 *   idx:board_jobs:{board}          → Set of job_ids for a board
 *   idx:job_status:{status}         → Set of composite keys board:job_id
 *   idx:tag:{tag}                   → Set of composite keys board:job_id
 *   idx:job_runs:{job_id}           → Set of run_ids for a job
 *   idx:runs                        → Set of all run_ids
 *   lock:apply:{board}:{job_id}     → SETNX lock (300s TTL)
 */

/* ══════════════════════ Board ══════════════════════ */

export type ATSType = "greenhouse" | "lever" | "ashby";

export interface Board {
  id: string;              // slug identifier used as Redis key (e.g. "stripe", "janestreet")
  company: string;         // display name (e.g. "Jane Street")
  ats: ATSType;            // ATS platform
  career_page_url: string; // public careers page
  created_at: string;      // ISO timestamp
}

/* ══════════════════════ Company (discovery) ══════════════════════
 *
 * Separate from Board: a **company** row stores the *marketing* slug (and optional
 * link to a registered `board_id`) used when expanding the job-discovery frontier
 * (e.g. `https://job-boards.greenhouse.io/{marketing_slug}`), which may or may
 * not equal the ATS API board token in `Board.id` for a given org.
 */
export interface Company {
  id: string;                 // primary key in Redis (e.g. same as your internal company id)
  marketing_slug: string;    // public careers-board slug (Greenhouse, etc.) for outbound discovery
  name: string;              // display name
  board_id: string;          // registered board id when 1:1; empty string if not linked yet
  created_at: string;        // ISO
  updated_at: string;        // ISO
}

/* ══════════════════════ Job ══════════════════════ */

export type JobStatus =
  | "discovered"   // found by crawler, not yet acted on
  | "queued"       // agent has claimed it, application in progress
  | "applied"      // confirmed application (has confirmation_url)
  | "rejected"     // application rejected or user dismissed
  | "expired";     // job no longer on the board

export interface Job {
  job_id: string;
  board: string;           // board id

  // core fields — set at discovery, may update on re-crawl
  title: string;
  url: string;
  location: string;
  department: string;
  tags: string[];          // auto-extracted from title+department (quant, ml, etc.)
  content_hash: string;    // SHA256(title|location|department) — detect real changes

  // lifecycle
  status: JobStatus;
  discovered_at: string;   // first time crawler saw this job
  updated_at: string;      // last status or content change
  last_seen_at: string;    // last crawl where this job was still on the board

  // application tracking — null until applied
  applied_at: string | null;
  applied_run_id: string | null;
}

/* ══════════════════════ Run ══════════════════════ */

export type RunStatus =
  | "pending"      // agent claimed the job, hasn't started form
  | "submitted"    // form submitted, awaiting confirmation
  | "success"      // application confirmed (confirmation_url present)
  | "failed";      // something went wrong

export interface RunArtifacts {
  resume_url?: string;                // blob key or URL of resume used
  resume_variant_id?: string;         // which variant was selected
  cover_letter?: string;              // generated cover letter text
  answers?: Record<string, string>;   // form field answers submitted
  confirmation_url?: string;          // confirmation page URL — proof of application
  screenshot_keys?: string[];         // blob keys for submission screenshots
  notes?: string;                     // agent or human notes
}

export interface Run {
  run_id: string;
  job_id: string;
  board: string;
  user_id?: string;          // authenticated user who authorized this application
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  artifacts: RunArtifacts | null;
}

/* ══════════════════════ User ══════════════════════ */

export interface ResumeVariant {
  id: string;              // e.g. "quant-v3"
  name: string;            // display name
  blob_key: string;        // Netlify Blobs storage key
  file_hash: string;       // SHA256 of file content — detect changes
  created_at: string;
}

export interface User {
  id: string;
  email?: string;                    // Google email — set after first OAuth login
  google_sub?: string;               // Google subject ID for identity linking
  display_name?: string;             // from Google profile
  resumes: ResumeVariant[];
  answers: Record<string, string>;   // default form answers (e.g. visa, yoe)
  tags: string[];                    // interest tags — used to filter jobs
  updated_at: string;
}

/* ══════════════════════ Crawl ══════════════════════ */

export interface CrawlStats {
  boards_crawled: number;
  jobs_fetched: number;
  jobs_new: number;
  jobs_updated: number;   // content_hash changed on re-crawl
  jobs_removed: number;   // disappeared from ATS, marked expired
}

export interface Crawl {
  crawl_id: string;
  status: "pending" | "running" | "success" | "failed";
  trigger: "manual" | "scheduled";
  started_at: string;
  completed_at: string | null;
  error: string | null;
  stats: CrawlStats | null;
}

/* ══════════════════════ ATS Raw Types ══════════════════════
 * Platform-specific shapes returned by ATS APIs.
 * Normalized into Job by the fetcher layer.
 */

export interface GreenhouseRawJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  location: { name: string };
  departments?: Array<{ id: number; name: string }>;
}

export interface LeverRawJob {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;         // ms timestamp
  categories: {
    commitment?: string;
    department?: string;
    location?: string;
    team?: string;
  };
}

export interface AshbyRawJob {
  id: string;
  title: string;
  jobUrl: string;
  publishedAt: string;
  department?: string;
  team?: string;
  location: string;
  isRemote?: boolean;
}

/** Normalized shape returned by fetchers, before persisting as a Job. */
export interface FetchedJob {
  job_id: string;
  title: string;
  url: string;
  location: string;
  department: string;
}
