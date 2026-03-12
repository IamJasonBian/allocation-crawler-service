import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { createCrawl, updateCrawl, getCrawl, listCrawls } from "../../src/lib/entities.js";

/**
 * /api/crawler/crawls
 *
 * GET    - List all crawls
 * GET    ?id=<id> - Get single crawl
 * POST   { trigger } - Create a new crawl
 * PATCH  { crawl_id, status, error?, stats? } - Update a crawl
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const crawl = await getCrawl(r, id);
        if (!crawl) return json({ error: "Crawl not found" }, 404);
        return json(crawl);
      }
      const crawls = await listCrawls(r);
      return json({ count: crawls.length, crawls });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const VALID_TRIGGERS = ["manual", "scheduled"];
      if (!body.trigger || !VALID_TRIGGERS.includes(body.trigger)) {
        return json({ error: `trigger is required and must be one of: ${VALID_TRIGGERS.join(", ")}` }, 400);
      }
      const crawl_id = body.crawl_id || crypto.randomUUID();
      const crawl = await createCrawl(r, crawl_id, body.trigger);
      return json(crawl, 201);
    }

    if (req.method === "PATCH") {
      const body = await req.json();
      if (!body.crawl_id) return json({ error: "crawl_id is required" }, 400);
      const crawl = await updateCrawl(r, body.crawl_id, {
        status: body.status,
        error: body.error,
        stats: body.stats,
      });
      if (!crawl) return json({ error: "Crawl not found" }, 404);
      return json(crawl);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-crawls error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis(r);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/crawler/crawls",
  method: ["GET", "POST", "PATCH"],
};
