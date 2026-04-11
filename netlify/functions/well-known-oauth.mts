import type { Config } from "@netlify/functions";

/**
 * /.well-known/oauth-authorization-server
 *
 * RFC 8414 / RFC 9728 OAuth Authorization Server Metadata.
 * Allows MCP clients to auto-discover OAuth endpoints.
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const origin = url.origin;

  return new Response(
    JSON.stringify(
      {
        issuer: origin,
        authorization_endpoint: `${origin}/api/auth/authorize`,
        token_endpoint: `${origin}/api/auth/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
};

export const config: Config = {
  path: "/.well-known/oauth-authorization-server",
  method: ["GET"],
};
