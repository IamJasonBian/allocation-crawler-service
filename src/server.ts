import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// Import all route handlers — each is a (Request) => Promise<Response> function
import boardsHandler from "../netlify/functions/crawler-boards.mts";
import jobsHandler from "../netlify/functions/crawler-jobs.mts";
import usersHandler from "../netlify/functions/crawler-users.mts";
import swaggerHandler from "../netlify/functions/crawler-swagger.mts";
import authHandler from "../netlify/functions/auth-google.mts";
import mcpHandler from "../netlify/functions/mcp.mts";
import wellKnownHandler from "../netlify/functions/well-known-oauth.mts";

type Handler = (req: Request) => Promise<Response>;

/* ── Route table ── */

const routes: Array<{ pattern: string; match: (path: string) => boolean; handler: Handler }> = [
  { pattern: "/api/crawler/boards", match: (p) => p === "/api/crawler/boards", handler: boardsHandler },
  { pattern: "/api/crawler/jobs",   match: (p) => p === "/api/crawler/jobs",   handler: jobsHandler },
  { pattern: "/api/crawler/users",  match: (p) => p === "/api/crawler/users",  handler: usersHandler },
  { pattern: "/api/crawler/docs",   match: (p) => p === "/api/crawler/docs",   handler: swaggerHandler },
  { pattern: "/api/auth/*",         match: (p) => p.startsWith("/api/auth/"),  handler: authHandler },
  { pattern: "/api/mcp",            match: (p) => p === "/api/mcp",            handler: mcpHandler },
  { pattern: "/.well-known/oauth-authorization-server", match: (p) => p === "/.well-known/oauth-authorization-server", handler: wellKnownHandler },
];

/* ── Node http → Web Request/Response adapter ── */

async function nodeToWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const url = `${protocol}://${host}${req.url}`;

  const method = req.method || "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  const hasBody = method !== "GET" && method !== "HEAD";
  let body: Buffer | null = null;
  if (hasBody) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    body = Buffer.concat(chunks);
  }

  return new Request(url, {
    method,
    headers,
    body,
    // @ts-expect-error — Node 18+ supports duplex on Request
    duplex: hasBody ? "half" : undefined,
  });
}

async function webResponseToNode(webRes: Response, res: ServerResponse) {
  res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()));

  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

/* ── Server ── */

const server = createServer(async (req, res) => {
  // Handle redirects (302, 301)
  const handleWithRedirects = async (handler: Handler, webReq: Request): Promise<Response> => {
    const response = await handler(webReq);
    return response;
  };

  try {
    const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Health check
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Match route
    const route = routes.find((r) => r.match(pathname));
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const webReq = await nodeToWebRequest(req);
    const webRes = await handleWithRedirects(route.handler, webReq);

    // Add CORS headers
    webRes.headers.set("Access-Control-Allow-Origin", "*");

    await webResponseToNode(webRes, res);
  } catch (err: any) {
    console.error("Server error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

const PORT = parseInt(process.env.PORT || "3000", 10);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`accra server listening on port ${PORT}`);
});
