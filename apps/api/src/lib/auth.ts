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

export function signSession(user: SessionUser, secret: string) {
  return jwt.sign(user, secret, { expiresIn: "12h" });
}

// Accepts the httpOnly cookie set by /auth/login (browser) or an
// `Authorization: Bearer <token>` header (curl, scripts).
export function requireAuth(secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    const token =
      req.cookies?.[SESSION_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!token) return next(new HttpError(401, "Not signed in"));
    try {
      const payload = jwt.verify(token, secret) as SessionUser;
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
