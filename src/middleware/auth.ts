import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "../config/env.js";

export type AuthedUser = {
  id: string; // Supabase auth.users.id (uuid)
  email?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
    }
  }
}

/**
 * Supabase projects created on/after Oct 1 2025 sign user access tokens with
 * an asymmetric key (ES256) by default, not the legacy shared secret
 * (HS256). `jwt.verify(token, SUPABASE_JWT_SECRET)` only ever understood
 * HS256, so against a project on the new signing-keys system it rejected
 * every single token — that's the source of the 401s on every authenticated
 * route, not a missing/incorrect env var or a header that wasn't reaching
 * Express. The JWKS is fetched once and cached in memory by `jose`, so this
 * is still local, per-request verification with no round trip to Supabase
 * Auth — same architecture, just able to check the key type Supabase
 * actually used to sign the token.
 */
const JWKS = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ code: "unauthenticated", message: "Missing bearer token" });
  }

  const token = header.slice("Bearer ".length);

  try {
    // Primary path: asymmetric (ES256) tokens, verified against Supabase's
    // published JWKS — what current/new Supabase projects issue.
    const { payload } = await jwtVerify(token, JWKS);
    req.user = { id: payload.sub as string, email: payload.email as string | undefined };
    return next();
  } catch {
    // Fallback: projects still on the legacy shared secret issue HS256
    // tokens, which have no corresponding JWKS entry and always fail the
    // path above. SUPABASE_JWT_SECRET is only relevant here.
    try {
      const decoded = jwt.verify(token, env.SUPABASE_JWT_SECRET, { algorithms: ["HS256"] }) as {
        sub: string;
        email?: string;
      };
      req.user = { id: decoded.sub, email: decoded.email };
      return next();
    } catch {
      return res.status(401).json({ code: "invalid_token", message: "Token invalid or expired" });
    }
  }
}
