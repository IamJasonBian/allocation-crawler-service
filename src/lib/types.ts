/* ── Allocation Crawler Service Entities ── */

export interface Board {
  id: string;           // slug identifier (e.g. "stripe", "notion")
  company: string;      // display name
  created_at: string;   // ISO timestamp
}

export interface Job {
  job_id: string;
  board: string;        // board id this job belongs to
  title: string;
  url: string;
  location: string;
  department: string;
  status: "discovered" | "queued" | "applied" | "found" | "rejected" | "expired";
  discovered_at: string;
  updated_at: string;
}

export interface JobRun {
  run_id: string;
  job_id: string;
  board: string;
  variant_id: string;   // resume variant used
  status: "pending" | "submitted" | "success" | "failed";
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

export interface User {
  id: string;
  resumes: string[];    // list of resume variant IDs or paths
  answers: Record<string, string>; // question key → answer
  updated_at: string;
}
