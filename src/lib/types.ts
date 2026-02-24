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
  tags: string[];       // auto-extracted from title+department
  status: "discovered" | "queued" | "applied" | "found" | "rejected" | "expired";
  discovered_at: string;
  updated_at: string;
}

export interface RunArtifacts {
  resume_url?: string;                // which resume file/variant was used
  cover_letter?: string;              // generated cover letter text
  answers?: Record<string, string>;   // form field answers submitted
  confirmation_url?: string;          // confirmation page URL after submit
  notes?: string;                     // agent notes or human notes
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
  artifacts: RunArtifacts | null;
}

export interface User {
  id: string;
  resumes: string[];    // list of resume variant IDs or paths
  answers: Record<string, string>; // question key → answer
  tags: string[];       // interest tags (e.g. ["quant", "ml", "senior"])
  updated_at: string;
}
