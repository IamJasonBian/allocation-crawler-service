import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { upsertUser, getUser, listUsers } from "../../src/lib/entities.js";

/**
 * /api/crawler/users
 *
 * GET          - List all users
 * GET  ?id=    - Get single user
 * POST { id, resumes, answers } - Create or update a user
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const user = await getUser(r, id);
        if (!user) return json({ error: "User not found" }, 404);
        return json(user);
      }
      const users = await listUsers(r);
      return json({ count: users.length, users });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.id) return json({ error: "id is required" }, 400);
      const user = await upsertUser(
        r,
        body.id,
        body.resumes || [],
        body.answers || {}
      );
      return json(user, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-users error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis();
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/crawler/users",
  method: ["GET", "POST"],
};
