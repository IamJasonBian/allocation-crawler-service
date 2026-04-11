import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type Redis from "ioredis";

/* ── JWT ── */

const ALG = "HS256";
const ISSUER = "accra";
const TOKEN_TTL = "24h";

function getSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw) throw new Error("JWT_SECRET environment variable is not set");
  return new TextEncoder().encode(raw);
}

export interface AccraJwtPayload extends JWTPayload {
  sub: string;   // user ID
  email: string;
}

export async function signJwt(userId: string, email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecret());
}

export async function verifyJwt(token: string): Promise<AccraJwtPayload> {
  const { payload } = await jwtVerify(token, getSecret(), { issuer: ISSUER });
  return payload as AccraJwtPayload;
}

/* ── Request authentication ── */

export interface AuthResult {
  userId: string;
  email: string;
}

export async function authenticateRequest(
  req: Request,
): Promise<{ auth: AuthResult } | { error: Response }> {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) {
    return { error: jsonError("Missing or invalid Authorization header", 401) };
  }
  const token = header.slice(7);
  try {
    const payload = await verifyJwt(token);
    if (!payload.sub || !payload.email) {
      return { error: jsonError("Invalid token payload", 401) };
    }
    return { auth: { userId: payload.sub, email: payload.email } };
  } catch {
    return { error: jsonError("Invalid or expired token", 401) };
  }
}

/**
 * Gate authentication behind REQUIRE_AUTH env var.
 * Returns null when auth is not required (pass-through).
 */
export async function optionalAuth(
  req: Request,
): Promise<{ auth: AuthResult | null } | { error: Response }> {
  if (process.env.REQUIRE_AUTH !== "true") {
    return { auth: null };
  }
  return authenticateRequest(req);
}

/* ── PKCE helpers ── */

export function generateRandomString(length = 43): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function verifyCodeChallenge(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const expected = await createCodeChallenge(verifier);
  return expected === challenge;
}

/* ── OAuth Redis keys ── */

export const AuthK = {
  oauthState: (state: string) => `oauth_state:${state}`,
  userEmailIdx: (email: string) => `idx:user_email:${email}`,
};

/** Store OAuth state (PKCE verifier + metadata) in Redis with 10-minute TTL. */
export async function storeOAuthState(
  r: Redis,
  state: string,
  data: { code_challenge: string; redirect_uri: string; client_id?: string },
): Promise<void> {
  await r.set(AuthK.oauthState(state), JSON.stringify(data), "EX", 600);
}

/** Retrieve and delete OAuth state (one-time use). */
export async function consumeOAuthState(
  r: Redis,
  state: string,
): Promise<{ code_challenge: string; redirect_uri: string; client_id?: string } | null> {
  const key = AuthK.oauthState(state);
  const raw = await r.get(key);
  if (!raw) return null;
  await r.del(key);
  return JSON.parse(raw);
}

/** Store an MCP authorization code in Redis with 5-minute TTL. */
export async function storeAuthCode(
  r: Redis,
  code: string,
  data: { userId: string; email: string; code_challenge: string; redirect_uri: string },
): Promise<void> {
  await r.set(`auth_code:${code}`, JSON.stringify(data), "EX", 300);
}

/** Retrieve and delete an MCP authorization code (one-time use). */
export async function consumeAuthCode(
  r: Redis,
  code: string,
): Promise<{ userId: string; email: string; code_challenge: string; redirect_uri: string } | null> {
  const key = `auth_code:${code}`;
  const raw = await r.get(key);
  if (!raw) return null;
  await r.del(key);
  return JSON.parse(raw);
}

/* ── Helpers ── */

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
