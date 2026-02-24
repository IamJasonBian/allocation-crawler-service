# Application Flow — Concurrency & Dedup

## Problem

Multiple allocation-agents may run concurrently. Without guards, two agents can
both retrieve the same job and apply simultaneously — sending duplicate
applications.

## Solution: SETNX Locking

Redis `SET key value EX ttl NX` is atomic. It only succeeds if the key does not
already exist. We use this as a distributed lock per job.

```
Lock key:  lock:apply:{board}:{job_id}
Value:     run_id of the claiming agent
TTL:       300s (5 min) — auto-expires if agent crashes
```

## Application Lifecycle

```
                ┌─────────────┐
                │  discovered  │  ← job crawled from ATS
                └──────┬──────┘
                       │
         POST action:"run"  (agent claims job)
                       │
              ┌────────▼────────┐
              │ SETNX lock:apply│
              │ {board}:{job_id}│
              └────────┬────────┘
                       │
               ┌───────┴───────┐
               │               │
           lock acquired    lock exists
               │               │
               ▼               ▼
        check job status    409 Conflict
        (must be discovered  "Job already has an
         or queued)           active application"
               │
               ▼
        create run (pending)
        job → "queued"
               │
               ▼
        ┌─────────────┐
        │   queued     │  ← agent is applying
        └──────┬──────┘
               │
      PATCH run status
               │
        ┌──────┴──────┐
        │             │
     success       failed
        │             │
        ▼             ▼
  job → "applied"   any other active runs?
  lock deleted       │
        │        ┌───┴───┐
        ▼        no      yes
  ┌──────────┐   │       │
  │ applied  │   ▼       ▼
  └──────────┘ job →    lock deleted
             "discovered" (keep queued)
              lock deleted
```

## Status Transitions

| From         | To         | Trigger                          |
|-------------|------------|----------------------------------|
| discovered  | queued     | createRun — agent claims the job |
| queued      | applied    | updateRun status:"success"       |
| queued      | discovered | updateRun status:"failed" (no other active runs) |
| any         | expired    | manual/cleanup                   |
| any         | rejected   | manual                           |

## Artifacts

Each run stores application artifacts — what was actually submitted:

```json
{
  "resume_url": "s3://resumes/quant-v3.pdf",
  "cover_letter": "Dear Hiring Manager...",
  "answers": { "yoe": "5", "visa_required": "no" },
  "confirmation_url": "https://ramp.com/careers/confirm/abc123",
  "notes": "Applied via Greenhouse portal"
}
```

Artifacts are **merged incrementally** via PATCH. The agent can write
`resume_url` at run creation, then PATCH `answers` during the application, then
PATCH `confirmation_url` after submission — each PATCH merges into existing
artifacts without overwriting earlier fields.

## Concurrency Model

| Operation       | Concurrency | Safety mechanism         |
|----------------|-------------|--------------------------|
| Crawling       | Single writer | HSET/SADD idempotent    |
| Applying       | Multi-agent  | SETNX per-job lock       |
| Status updates | Multi-agent  | Lock holder only writes  |
| Reading        | Unrestricted | No locks needed          |

## API Reference

```bash
# Agent claims a job for application
POST /api/crawler/jobs
{
  "action": "run",
  "run_id": "uuid",
  "job_id": "12345",
  "board": "ramp",
  "variant_id": "resume-v2",
  "artifacts": { "resume_url": "s3://resumes/v2.pdf" }
}
# → 201 (created) | 409 (already claimed) | 400 (bad job status)

# Agent updates run progress with artifacts
PATCH /api/crawler/jobs
{
  "run_id": "uuid",
  "status": "submitted",
  "artifacts": { "answers": { "yoe": "5" } }
}

# Agent completes the application
PATCH /api/crawler/jobs
{
  "run_id": "uuid",
  "status": "success",
  "artifacts": { "confirmation_url": "https://..." }
}
# → job auto-transitions to "applied", lock released

# Agent reports failure
PATCH /api/crawler/jobs
{
  "run_id": "uuid",
  "status": "failed",
  "error": "Form submission timeout"
}
# → job reverts to "discovered" (if no other active runs), lock released

# UI retrieves application history with artifacts
GET /api/crawler/jobs?runs_for=12345
```
