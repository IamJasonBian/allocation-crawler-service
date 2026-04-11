import type { Config } from "@netlify/functions";
import { getRedis, disconnectRedis } from "../../src/lib/redis.js";
import {
  signJwt,
  authenticateRequest,
  generateRandomString,
  createCodeChallenge,
  verifyCodeChallenge,
  storeOAuthState,
  consumeOAuthState,
  storeAuthCode,
  consumeAuthCode,
} from "../../src/lib/auth.js";
import { getUser, getUserByEmail, upsertUser, linkUserEmail } from "../../src/lib/entities.js";

/**
 * /api/auth/*
 *
 * GET  /api/auth/authorize  - Start OAuth flow → redirect to Google
 * GET  /api/auth/callback   - Google redirects here → issue accra JWT
 * POST /api/auth/token      - RFC 9728 token exchange (code + code_verifier → JWT)
 * GET  /api/auth/me         - Protected — return authenticated user profile
 */
export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  const r = getRedis();

  try {
    /* ── /api/auth/authorize ── */
    if (path === "/api/auth/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") || "browser";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || generateRandomString();
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";

      // For MCP clients providing PKCE
      const challenge = codeChallenge || generateRandomString();

      await storeOAuthState(r, state, {
        code_challenge: challenge,
        redirect_uri: redirectUri,
        client_id: clientId,
      });

      const googleClientId = process.env.GOOGLE_CLIENT_ID;
      if (!googleClientId) {
        return json({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
      }

      const callbackUrl = `${url.origin}/api/auth/callback`;
      const googleUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      googleUrl.searchParams.set("client_id", googleClientId);
      googleUrl.searchParams.set("redirect_uri", callbackUrl);
      googleUrl.searchParams.set("response_type", "code");
      googleUrl.searchParams.set("scope", "openid email profile");
      googleUrl.searchParams.set("state", state);
      googleUrl.searchParams.set("access_type", "offline");
      googleUrl.searchParams.set("prompt", "consent");

      return Response.redirect(googleUrl.toString(), 302);
    }

    /* ── /api/auth/callback ── */
    if (path === "/api/auth/callback" && req.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return json({ error: `Google OAuth error: ${error}` }, 400);
      }
      if (!code || !state) {
        return json({ error: "Missing code or state parameter" }, 400);
      }

      // Retrieve stored state
      const oauthState = await consumeOAuthState(r, state);
      if (!oauthState) {
        return json({ error: "Invalid or expired state — please restart the OAuth flow" }, 400);
      }

      // Exchange Google auth code for tokens
      const callbackUrl = `${url.origin}/api/auth/callback`;
      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: callbackUrl,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        console.error("Google token exchange failed:", err);
        return json({ error: "Failed to exchange Google auth code" }, 500);
      }

      const tokenData = await tokenResp.json() as {
        id_token?: string;
        access_token?: string;
      };

      if (!tokenData.id_token) {
        return json({ error: "No ID token in Google response" }, 500);
      }

      // Verify Google ID token
      const tokenInfoResp = await fetch(
        `https://oauth2.googleapis.com/tokeninfo?id_token=${tokenData.id_token}`,
      );
      if (!tokenInfoResp.ok) {
        return json({ error: "Failed to verify Google ID token" }, 500);
      }

      const googleUser = await tokenInfoResp.json() as {
        sub: string;
        email: string;
        email_verified: string;
        name?: string;
        picture?: string;
        aud: string;
      };

      // Validate
      if (googleUser.aud !== process.env.GOOGLE_CLIENT_ID) {
        return json({ error: "Token audience mismatch" }, 401);
      }
      if (googleUser.email_verified !== "true") {
        return json({ error: "Email not verified with Google" }, 401);
      }

      // Find or create user
      let user = await getUserByEmail(r, googleUser.email);
      if (!user) {
        // Auto-create user with email as ID
        const userId = googleUser.email.split("@")[0];
        user = await upsertUser(r, userId, [], {}, []);
        await linkUserEmail(r, userId, googleUser.email, googleUser.sub, googleUser.name);
        user = await getUser(r, userId);
      } else if (!user.google_sub) {
        await linkUserEmail(r, user.id, googleUser.email, googleUser.sub, googleUser.name);
      }

      const userId = user!.id;

      // If there's a redirect_uri from MCP client, issue an auth code
      if (oauthState.redirect_uri) {
        const authCode = generateRandomString(64);
        await storeAuthCode(r, authCode, {
          userId,
          email: googleUser.email,
          code_challenge: oauthState.code_challenge,
          redirect_uri: oauthState.redirect_uri,
        });

        const redirectUrl = new URL(oauthState.redirect_uri);
        redirectUrl.searchParams.set("code", authCode);
        redirectUrl.searchParams.set("state", state);
        return Response.redirect(redirectUrl.toString(), 302);
      }

      // Browser-based flow — return JWT directly
      const jwt = await signJwt(userId, googleUser.email);
      return json({
        access_token: jwt,
        token_type: "Bearer",
        expires_in: 86400,
        user: {
          id: userId,
          email: googleUser.email,
          display_name: googleUser.name,
        },
      });
    }

    /* ── /api/auth/token ── */
    if (path === "/api/auth/token" && req.method === "POST") {
      const body = await parseFormOrJson(req);
      const grantType = body.grant_type;

      if (grantType !== "authorization_code") {
        return json({ error: "unsupported_grant_type" }, 400);
      }

      const code = body.code;
      const codeVerifier = body.code_verifier;

      if (!code) {
        return json({ error: "invalid_request", error_description: "code is required" }, 400);
      }

      const authCode = await consumeAuthCode(r, code);
      if (!authCode) {
        return json({ error: "invalid_grant", error_description: "Invalid or expired code" }, 400);
      }

      // Verify PKCE if a code_verifier is provided
      if (codeVerifier) {
        const valid = await verifyCodeChallenge(codeVerifier, authCode.code_challenge);
        if (!valid) {
          return json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        }
      }

      const jwt = await signJwt(authCode.userId, authCode.email);
      return json({
        access_token: jwt,
        token_type: "Bearer",
        expires_in: 86400,
      });
    }

    /* ── /api/auth/me ── */
    if (path === "/api/auth/me" && req.method === "GET") {
      const result = await authenticateRequest(req);
      if ("error" in result) return result.error;

      const user = await getUser(r, result.auth.userId);
      if (!user) return json({ error: "User not found" }, 404);
      return json(user);
    }

    return json({ error: "Not found" }, 404);
  } catch (error: any) {
    console.error("auth-google error:", error);
    return json({ error: error.message }, 500);
  } finally {
    await disconnectRedis(r);
  }
};

async function parseFormOrJson(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await req.text();
    return Object.fromEntries(new URLSearchParams(text));
  }
  return await req.json();
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const config: Config = {
  path: "/api/auth/*",
  method: ["GET", "POST"],
};
