import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { Role } from "@irp/shared";
import { HttpError } from "./http";

export const SESSION_COOKIE = "irp_session";

export type SessionUser = {
  id: number;
  organizationId: number;
  role: Role;
  name: string;
  email: string;
};

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
  }
}

// Sessions are HS256 JWTs. Verification pins the algorithm (so a token
// claiming "alg: none" or another algorithm is refused) and checks issuer and
// audience, so a token minted for something else with the same secret can't
// be replayed here.
const JWT_OPTIONS = { algorithm: "HS256", issuer: "fireline-api", audience: "fireline-web" } as const;
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function signSession(user: SessionUser, secret: string) {
  return jwt.sign(user, secret, { ...JWT_OPTIONS, expiresIn: SESSION_TTL_SECONDS });
}

// Accepts an `Authorization: Bearer <token>` header (curl, scripts) or the
// httpOnly cookie set by /auth/login (browser). The header wins when both are
// present; cookie-authenticated writes are additionally Origin-checked
// (csrfProtection in security.ts).
export function requireAuth(secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token = (header?.startsWith("Bearer ") ? header.slice(7) : undefined) ?? req.cookies?.[SESSION_COOKIE];
    if (!token) return next(new HttpError(401, "Not signed in"));
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: [JWT_OPTIONS.algorithm],
        issuer: JWT_OPTIONS.issuer,
        audience: JWT_OPTIONS.audience,
      }) as SessionUser;
      req.user = {
        id: payload.id,
        organizationId: payload.organizationId,
        role: payload.role,
        name: payload.name,
        email: payload.email,
      };
      next();
    } catch {
      next(new HttpError(401, "Session expired or invalid"));
    }
  };
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return next(new HttpError(403, "Admins only"));
  next();
}
