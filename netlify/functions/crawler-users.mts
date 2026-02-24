import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { upsertUser, getUser, listUsers } from "../../src/lib/entities.js";

/**
 * /api/crawler/users
 *
 * GET              - List all users
 * GET  ?id=        - Get single user
 * GET  ?blob=<key> - Serve a stored resume blob
 * POST (JSON)      - Create or update a user
 * POST (multipart) - Upload a resume file to blob storage
 */
export default async (req: Request) => {
  const r = getRedis();

  try {
    const url = new URL(req.url);

    if (req.method === "GET") {
      // Serve a blob
      const blobKey = url.searchParams.get("blob");
      if (blobKey) {
        const store = getStore("resumes");
        const blob = await store.get(blobKey, { type: "arrayBuffer" });
        if (!blob) return json({ error: "Blob not found" }, 404);
        const contentType = blobKey.endsWith(".pdf")
          ? "application/pdf"
          : "application/octet-stream";
        return new Response(blob, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Disposition": `inline; filename="${blobKey.split("/").pop()}"`,
          },
        });
      }

      // Get single user
      const id = url.searchParams.get("id");
      if (id) {
        const user = await getUser(r, id);
        if (!user) return json({ error: "User not found" }, 404);
        return json(user);
      }

      // List all users
      const users = await listUsers(r);
      return json({ count: users.length, users });
    }

    if (req.method === "POST") {
      const contentType = req.headers.get("content-type") || "";

      // Handle multipart resume upload
      if (contentType.includes("multipart/form-data")) {
        const formData = await req.formData();
        const file = formData.get("file") as File | null;
        const userId = formData.get("userId") as string | null;
        if (!file || !userId) {
          return json({ error: "file and userId are required" }, 400);
        }

        const key = `${userId}/${file.name}`;
        const store = getStore("resumes");
        const buffer = await file.arrayBuffer();
        await store.set(key, buffer, {
          metadata: {
            originalName: file.name,
            size: String(file.size),
            uploadedAt: new Date().toISOString(),
          },
        });

        return json(
          {
            key,
            url: `/api/crawler/users?blob=${encodeURIComponent(key)}`,
            size: file.size,
            name: file.name,
          },
          201,
        );
      }

      // Handle JSON user upsert
      const body = await req.json();
      if (!body.id) return json({ error: "id is required" }, 400);
      const user = await upsertUser(
        r,
        body.id,
        body.resumes || [],
        body.answers || {},
        body.tags || []
      );
      return json(user, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error: any) {
    console.error("crawler-users error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis(r);
  }
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const config: Config = {
  path: "/api/crawler/users",
  method: ["GET", "POST"],
};
