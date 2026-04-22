import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { getCompany, listCompanies, removeCompany, upsertCompany } from "../../src/lib/entities.js";
import { optionalAuth } from "../../src/lib/auth.js";

/**
 * /api/crawler/companies
 *
 * GET    - List all company discovery records; ?id= for one
 * PUT    - Create or update (marketing_slug, name, optional board_id)
 * DELETE { id } - Remove a company record (does not delete the board)
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const authResult = await optionalAuth(req);
    if ("error" in authResult) return authResult.error;

    const url = new URL(req.url);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const company = await getCompany(r, id);
        if (!company) return json({ error: "Company not found" }, 404);
        return json(company);
      }
      const companies = await listCompanies(r);
      return json({ count: companies.length, companies });
    }

    if (req.method === "PUT") {
      const body = await req.json();
      if (!body.id || !body.marketing_slug) {
        return json({ error: "id and marketing_slug are required" }, 400);
      }
      const company = await upsertCompany(
        r,
        String(body.id),
        String(body.marketing_slug),
        String(body.name || body.id),
        body.board_id != null ? String(body.board_id) : "",
      );
      return json(company, 200);
    }

    if (req.method === "DELETE") {
      const body = await req.json();
      if (!body.id) return json({ error: "id is required" }, 400);
      const removed = await removeCompany(r, body.id);
      if (!removed) return json({ error: "Company not found" }, 404);
      return json({ success: true, id: body.id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-companies error:", error);
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
  path: "/api/crawler/companies",
  method: ["GET", "PUT", "DELETE"],
};
