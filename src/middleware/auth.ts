import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
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
 * Verifies the Supabase-issued JWT the frontend already attaches to
 * requests (it's the same token used for RLS-scoped Supabase calls today).
 * Verified locally against SUPABASE_JWT_SECRET — no network round trip to
 * Supabase Auth per request.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ code: "unauthenticated", message: "Missing bearer token" });
  }

  const token = header.slice("Bearer ".length);

  try {
    const decoded = jwt.verify(token, env.SUPABASE_JWT_SECRET) as { sub: string; email?: string };
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch {
    return res.status(401).json({ code: "invalid_token", message: "Token invalid or expired" });
  }
}
