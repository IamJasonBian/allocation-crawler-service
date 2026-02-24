import type { Config } from "@netlify/functions";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Allocation Crawler Service",
    version: "1.0.0",
    description: "API for managing boards (companies), jobs, job runs, and users for the allocation crawler pipeline.",
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
        summary: "Add a board (filtered company)",
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
        description: "List/filter jobs by board and status. Use ?runs_for= to list job runs instead (empty string for all runs, or a job_id to filter).",
        parameters: [
          { name: "board", in: "query", schema: { type: "string" }, description: "Filter by board ID" },
          { name: "status", in: "query", schema: { type: "string", enum: ["discovered", "queued", "applied", "found", "rejected", "expired"] } },
          { name: "id", in: "query", schema: { type: "string" }, description: "Get single job (requires board param)" },
          { name: "runs_for", in: "query", schema: { type: "string" }, description: "List runs. Pass job_id to filter, or empty string for all runs." },
        ],
        responses: {
          "200": { description: "Jobs or runs returned" },
        },
      },
      post: {
        summary: "Add jobs or perform actions (run, notify, cleanup, retrieve)",
        description: "Without 'action': add a single job or bulk jobs. With 'action': run (create job run), notify (Slack digest), cleanup (remove processed), retrieve (get jobs for agent).",
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
                    properties: { jobs: { type: "array", items: { $ref: "#/components/schemas/JobInput" } } },
                  },
                  {
                    title: "Create job run",
                    type: "object",
                    required: ["action", "run_id", "job_id", "board", "variant_id"],
                    properties: {
                      action: { type: "string", enum: ["run"] },
                      run_id: { type: "string" },
                      job_id: { type: "string" },
                      board: { type: "string" },
                      variant_id: { type: "string" },
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
                    },
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
        },
      },
      patch: {
        summary: "Update job status or run status",
        description: "With run_id: updates a run. With board+job_id: updates a job status.",
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
                      status: { type: "string", enum: ["discovered", "queued", "applied", "found", "rejected", "expired"] },
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
        summary: "List users",
        parameters: [
          { name: "id", in: "query", schema: { type: "string" }, description: "Get single user" },
        ],
        responses: {
          "200": { description: "User(s) returned", content: { "application/json": { schema: { $ref: "#/components/schemas/UserList" } } } },
        },
      },
      post: {
        summary: "Create or update a user",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/UserInput" } } },
        },
        responses: {
          "201": { description: "User upserted", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      Board: {
        type: "object",
        properties: {
          id: { type: "string" },
          company: { type: "string" },
          created_at: { type: "string", format: "date-time" },
        },
      },
      BoardInput: {
        type: "object",
        required: ["id", "company"],
        properties: {
          id: { type: "string", example: "stripe" },
          company: { type: "string", example: "Stripe" },
        },
      },
      BoardList: {
        type: "object",
        properties: {
          count: { type: "integer" },
          boards: { type: "array", items: { $ref: "#/components/schemas/Board" } },
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
          status: { type: "string", enum: ["discovered", "queued", "applied", "found", "rejected", "expired"] },
          discovered_at: { type: "string", format: "date-time" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      JobInput: {
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
      JobRun: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          job_id: { type: "string" },
          board: { type: "string" },
          variant_id: { type: "string" },
          status: { type: "string", enum: ["pending", "submitted", "success", "failed"] },
          started_at: { type: "string", format: "date-time" },
          completed_at: { type: "string", format: "date-time", nullable: true },
          error: { type: "string", nullable: true },
        },
      },
      User: {
        type: "object",
        properties: {
          id: { type: "string" },
          resumes: { type: "array", items: { type: "string" } },
          answers: { type: "object", additionalProperties: { type: "string" } },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      UserInput: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          resumes: { type: "array", items: { type: "string" } },
          answers: { type: "object", additionalProperties: { type: "string" } },
        },
      },
      UserList: {
        type: "object",
        properties: {
          count: { type: "integer" },
          users: { type: "array", items: { $ref: "#/components/schemas/User" } },
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

export const config: Config = {
  path: "/api/crawler/docs",
};
