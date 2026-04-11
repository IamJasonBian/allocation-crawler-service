
const spec = {
  openapi: "3.0.3",
  info: {
    title: "Allocation Crawler Service",
    version: "2.0.0",
    description: "Unified API for job discovery, application tracking, and user management across the allocation pipeline.",
  },
  servers: [{ url: "/api/crawler" }],
  paths: {
    "/boards": {
      get: {
        summary: "List boards",
        parameters: [
          { name: "id", in: "query", schema: { type: "string" }, description: "Get a single board by ID" },
        ],
        responses: {
          "200": { description: "Board(s) returned", content: { "application/json": { schema: { $ref: "#/components/schemas/BoardList" } } } },
          "404": { description: "Board not found" },
        },
      },
      post: {
        summary: "Add a board",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/BoardInput" } } },
        },
        responses: {
          "201": { description: "Board created", content: { "application/json": { schema: { $ref: "#/components/schemas/Board" } } } },
          "400": { description: "Missing required fields" },
        },
      },
      delete: {
        summary: "Remove a board and all its jobs",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } },
        },
        responses: {
          "200": { description: "Board removed" },
          "404": { description: "Board not found" },
        },
      },
    },
    "/jobs": {
      get: {
        summary: "List jobs or runs",
        parameters: [
          { name: "board", in: "query", schema: { type: "string" }, description: "Filter by board ID" },
          { name: "status", in: "query", schema: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] } },
          { name: "tag", in: "query", schema: { type: "string" }, description: "Filter by auto-extracted tag" },
          { name: "id", in: "query", schema: { type: "string" }, description: "Get single job (requires board param)" },
          { name: "runs_for", in: "query", schema: { type: "string" }, description: "List runs. Pass job_id to filter, or empty string for all." },
        ],
        responses: { "200": { description: "Jobs or runs returned" } },
      },
      post: {
        summary: "Add jobs or perform actions",
        description: "Without 'action': add a single job or bulk jobs. With 'action': run, notify, cleanup, retrieve, check, or crawl.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "Add single job",
                    type: "object",
                    required: ["job_id", "board"],
                    properties: {
                      job_id: { type: "string" },
                      board: { type: "string" },
                      title: { type: "string" },
                      url: { type: "string" },
                      location: { type: "string" },
                      department: { type: "string" },
                    },
                  },
                  {
                    title: "Bulk add jobs",
                    type: "object",
                    required: ["jobs"],
                    properties: { jobs: { type: "array", items: { $ref: "#/components/schemas/FetchedJob" } } },
                  },
                  {
                    title: "Create run (claim a job for application)",
                    type: "object",
                    required: ["action", "run_id", "job_id", "board"],
                    properties: {
                      action: { type: "string", enum: ["run"] },
                      run_id: { type: "string" },
                      job_id: { type: "string" },
                      board: { type: "string" },
                      artifacts: { $ref: "#/components/schemas/RunArtifacts" },
                    },
                  },
                  {
                    title: "Notify / Cleanup / Retrieve",
                    type: "object",
                    required: ["action"],
                    properties: {
                      action: { type: "string", enum: ["notify", "cleanup", "retrieve"] },
                      board: { type: "string", description: "Optional board filter" },
                      status: { type: "string", description: "Optional status filter" },
                      user: { type: "string", description: "User ID for retrieve — filters by interest tags" },
                    },
                  },
                  {
                    title: "Check applied jobs",
                    type: "object",
                    required: ["action"],
                    properties: {
                      action: { type: "string", enum: ["check"] },
                      board: { type: "string", description: "Optional board filter" },
                    },
                    description: "Returns verified (has confirmation_url) vs unverified applied jobs",
                  },
                  {
                    title: "Crawl all boards",
                    type: "object",
                    required: ["action"],
                    properties: { action: { type: "string", enum: ["crawl"] } },
                    description: "Fetches all registered boards from their ATS APIs, inserts new jobs, updates changed ones",
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "Action completed" },
          "201": { description: "Job(s) or run created" },
          "400": { description: "Missing required fields" },
          "409": { description: "Conflict — job already has an active run" },
        },
      },
      patch: {
        summary: "Update job or run status",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  {
                    title: "Update job status",
                    type: "object",
                    required: ["board", "job_id", "status"],
                    properties: {
                      board: { type: "string" },
                      job_id: { type: "string" },
                      status: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] },
                    },
                  },
                  {
                    title: "Update run status",
                    type: "object",
                    required: ["run_id", "status"],
                    properties: {
                      run_id: { type: "string" },
                      status: { type: "string", enum: ["pending", "submitted", "success", "failed"] },
                      error: { type: "string" },
                      artifacts: { $ref: "#/components/schemas/RunArtifacts", description: "Merged with existing — include confirmation_url for verified applied" },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: {
          "200": { description: "Updated" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        summary: "Remove a job",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["board", "job_id"], properties: { board: { type: "string" }, job_id: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": { description: "Job removed" },
          "404": { description: "Job not found" },
        },
      },
    },
    "/users": {
      get: {
        summary: "List users or serve resume blob",
        parameters: [
          { name: "id", in: "query", schema: { type: "string" }, description: "Get single user" },
          { name: "blob", in: "query", schema: { type: "string" }, description: "Serve a stored resume file by blob key" },
        ],
        responses: {
          "200": { description: "User(s) or blob returned" },
        },
      },
      post: {
        summary: "Create/update user or upload resume",
        description: "JSON body: upsert user profile. Multipart form: upload resume to blob storage.",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/UserInput" } },
            "multipart/form-data": {
              schema: {
                type: "object",
                required: ["file", "userId"],
                properties: {
                  file: { type: "string", format: "binary" },
                  userId: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "User upserted or resume uploaded" },
        },
      },
    },
    "/crawls": {
      get: {
        summary: "List crawls",
        parameters: [
          { name: "id", in: "query", schema: { type: "string" }, description: "Get a single crawl by ID" },
        ],
        responses: {
          "200": { description: "Crawl(s) returned", content: { "application/json": { schema: { $ref: "#/components/schemas/CrawlList" } } } },
          "404": { description: "Crawl not found" },
        },
      },
      post: {
        summary: "Create a new crawl",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CrawlInput" } } },
        },
        responses: {
          "201": { description: "Crawl created" },
          "400": { description: "Missing or invalid trigger" },
        },
      },
      patch: {
        summary: "Update a crawl",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["crawl_id"],
                properties: {
                  crawl_id: { type: "string" },
                  status: { type: "string", enum: ["pending", "running", "success", "failed"] },
                  error: { type: "string", nullable: true },
                  stats: { $ref: "#/components/schemas/CrawlStats" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Crawl updated" },
          "404": { description: "Crawl not found" },
        },
      },
    },
  },
  components: {
    schemas: {
      Board: {
        type: "object",
        properties: {
          id: { type: "string", description: "Slug identifier (e.g. janestreet, stripe)" },
          company: { type: "string", description: "Display name" },
          ats: { type: "string", enum: ["greenhouse", "lever", "ashby"] },
          career_page_url: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      BoardInput: {
        type: "object",
        required: ["id", "company", "ats"],
        properties: {
          id: { type: "string", example: "stripe" },
          company: { type: "string", example: "Stripe" },
          ats: { type: "string", enum: ["greenhouse", "lever", "ashby"] },
          career_page_url: { type: "string", example: "https://stripe.com/jobs" },
        },
      },
      BoardList: {
        type: "object",
        properties: {
          count: { type: "integer" },
          boards: { type: "array", items: { $ref: "#/components/schemas/Board" } },
        },
      },
      FetchedJob: {
        type: "object",
        description: "Normalized job from an ATS API, before persistence",
        required: ["job_id", "title", "url", "location", "department"],
        properties: {
          job_id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          location: { type: "string" },
          department: { type: "string" },
        },
      },
      Job: {
        type: "object",
        properties: {
          job_id: { type: "string" },
          board: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          location: { type: "string" },
          department: { type: "string" },
          tags: { type: "array", items: { type: "string" }, description: "Auto-extracted from title+department" },
          content_hash: { type: "string", description: "SHA256(title|location|department) — detect real changes across crawls" },
          status: { type: "string", enum: ["discovered", "queued", "applied", "rejected", "expired"] },
          discovered_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
          last_seen_at: { type: "string", format: "date-time", description: "Last crawl where this job was still on the board" },
          applied_at: { type: "string", format: "date-time", nullable: true },
          applied_run_id: { type: "string", nullable: true },
        },
      },
      RunArtifacts: {
        type: "object",
        description: "Evidence and materials from a job application attempt",
        properties: {
          resume_url: { type: "string", description: "Blob key or URL of resume used" },
          resume_variant_id: { type: "string", description: "Which resume variant was selected" },
          cover_letter: { type: "string" },
          answers: { type: "object", additionalProperties: { type: "string" }, description: "Form field answers submitted" },
          confirmation_url: { type: "string", description: "Confirmation page URL — required for verified applied status" },
          screenshot_keys: { type: "array", items: { type: "string" }, description: "Blob keys for submission screenshots" },
          notes: { type: "string" },
        },
      },
      Run: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          job_id: { type: "string" },
          board: { type: "string" },
          status: { type: "string", enum: ["pending", "submitted", "success", "failed"] },
          started_at: { type: "string", format: "date-time" },
          completed_at: { type: "string", format: "date-time", nullable: true },
          error: { type: "string", nullable: true },
          artifacts: { $ref: "#/components/schemas/RunArtifacts", nullable: true },
        },
      },
      ResumeVariant: {
        type: "object",
        properties: {
          id: { type: "string", description: "e.g. quant-v3" },
          name: { type: "string", description: "Display name" },
          blob_key: { type: "string", description: "Netlify Blobs storage key" },
          file_hash: { type: "string", description: "SHA256 of file content" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          resumes: { type: "array", items: { $ref: "#/components/schemas/ResumeVariant" } },
          answers: { type: "object", additionalProperties: { type: "string" }, description: "Default form answers (visa, yoe, etc.)" },
          tags: { type: "array", items: { type: "string" }, description: "Interest tags for job filtering" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      UserInput: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          resumes: { type: "array", items: { $ref: "#/components/schemas/ResumeVariant" } },
          answers: { type: "object", additionalProperties: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      CrawlStats: {
        type: "object",
        properties: {
          boards_crawled: { type: "integer" },
          jobs_fetched: { type: "integer" },
          jobs_new: { type: "integer" },
          jobs_updated: { type: "integer" },
          jobs_removed: { type: "integer" },
        },
      },
      Crawl: {
        type: "object",
        properties: {
          crawl_id: { type: "string" },
          status: { type: "string", enum: ["pending", "running", "success", "failed"] },
          trigger: { type: "string", enum: ["manual", "scheduled"] },
          started_at: { type: "string", format: "date-time" },
          completed_at: { type: "string", format: "date-time", nullable: true },
          error: { type: "string", nullable: true },
          stats: { $ref: "#/components/schemas/CrawlStats", nullable: true },
        },
      },
      CrawlInput: {
        type: "object",
        required: ["trigger"],
        properties: {
          trigger: { type: "string", enum: ["manual", "scheduled"] },
          crawl_id: { type: "string", description: "Optional custom ID; auto-generated if omitted" },
        },
      },
      CrawlList: {
        type: "object",
        properties: {
          count: { type: "integer" },
          crawls: { type: "array", items: { $ref: "#/components/schemas/Crawl" } },
        },
      },
    },
  },
};

const swaggerHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Allocation Crawler Service - API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      spec: ${JSON.stringify(spec)},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout",
    });
  </script>
</body>
</html>`;

export default async (req: Request) => {
  const url = new URL(req.url);

  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify(spec, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(swaggerHtml, {
    headers: { "Content-Type": "text/html" },
  });
};

