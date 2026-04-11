import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import { authenticateRequest } from "../../src/lib/auth.js";
import { tools, handleToolCall } from "../../src/lib/mcp-tools.js";

/**
 * /api/mcp — MCP Streamable HTTP transport
 *
 * Handles JSON-RPC messages for MCP protocol:
 *   - initialize
 *   - tools/list
 *   - tools/call (requires Bearer JWT authentication)
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed — POST required" }, 405);
  }

  const r = getRedis();

  try {
    const message = await req.json() as {
      jsonrpc: string;
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };

    if (message.jsonrpc !== "2.0") {
      return jsonrpcError(message.id, -32600, "Invalid JSON-RPC version");
    }

    switch (message.method) {
      case "initialize":
        return jsonrpcResult(message.id, {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: {
            name: "accra",
            version: "1.0.0",
          },
        });

      case "notifications/initialized":
        // Acknowledgement — no response needed for notifications
        return new Response(null, { status: 204 });

      case "tools/list":
        return jsonrpcResult(message.id, { tools });

      case "tools/call": {
        const params = message.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!params?.name) {
          return jsonrpcError(message.id, -32602, "Missing tool name");
        }

        // Authenticate — tool calls require a valid JWT
        let userId: string | null = null;
        const authResult = await authenticateRequest(req);
        if ("auth" in authResult) {
          userId = authResult.auth.userId;
        }
        // Allow unauthenticated tool calls for read-only tools when REQUIRE_AUTH is not set
        if (!userId && process.env.REQUIRE_AUTH === "true") {
          return jsonrpcError(message.id, -32001, "Authentication required");
        }

        const toolResult = await handleToolCall(r, params.name, params.arguments || {}, userId);
        return jsonrpcResult(message.id, toolResult);
      }

      case "ping":
        return jsonrpcResult(message.id, {});

      default:
        return jsonrpcError(message.id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error: any) {
    console.error("mcp error:", error);
    return jsonrpcError(undefined, -32603, error.message);
  } finally {
    await disconnectRedis(r);
  }
};

function jsonrpcResult(id: string | number | undefined, result: unknown) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function jsonrpcError(id: string | number | undefined, code: number, message: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

