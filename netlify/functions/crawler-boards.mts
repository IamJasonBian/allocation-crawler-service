import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { addBoard, removeBoard, listBoards, getBoard } from "../../src/lib/entities.js";

/**
 * /api/crawler/boards
 *
 * GET    - List all boards
 * GET    ?id=<id> - Get single board
 * POST   { id, company } - Add a board (filtered company)
 * DELETE { id } - Remove a board and its jobs
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      const id = url.searchParams.get("id");
      if (id) {
        const board = await getBoard(r, id);
        if (!board) return json({ error: "Board not found" }, 404);
        return json(board);
      }
      const boards = await listBoards(r);
      return json({ count: boards.length, boards });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (!body.id || !body.company) {
        return json({ error: "id and company are required" }, 400);
      }
      const board = await addBoard(r, body.id, body.company);
      return json(board, 201);
    }

    if (req.method === "DELETE") {
      const body = await req.json();
      if (!body.id) return json({ error: "id is required" }, 400);
      const removed = await removeBoard(r, body.id);
      if (!removed) return json({ error: "Board not found" }, 404);
      return json({ success: true, id: body.id });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-boards error:", error);
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
  path: "/api/crawler/boards",
  method: ["GET", "POST", "DELETE"],
};
