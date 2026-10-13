import bcrypt from "bcryptjs";
import { Router } from "express";
import { loginSchema } from "@irp/shared";
import type { Deps } from "../deps";
import { requireAuth, SESSION_COOKIE, signSession, type SessionUser } from "../lib/auth";
import { HttpError } from "../lib/http";

export function authRouter(deps: Deps) {
  const router = Router();

  router.post("/login", async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const { rows } = await deps.pool.query(
      `SELECT u.id, u.name, u.email, u.password_hash, m.organization_id, m.role, o.name AS organization_name
       FROM users u
       JOIN organization_members m ON m.user_id = u.id
       JOIN organizations o ON o.id = m.organization_id
       WHERE lower(u.email) = lower($1)
       ORDER BY m.organization_id LIMIT 1`,
      [email]
    );
    const row = rows[0];
    // Same message for "no such user" and "wrong password", so the endpoint
    // can't be used to discover which emails have accounts.
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      throw new HttpError(401, "Invalid email or password");
    }

    const user: SessionUser = {
      id: row.id,
      organizationId: row.organization_id,
      role: row.role,
      name: row.name,
      email: row.email,
    };
    const token = signSession(user, deps.jwtSecret);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: deps.secureCookies,
      maxAge: 12 * 60 * 60 * 1000,
    });
    // The token is also returned for API clients (curl, scripts) that use
    // `Authorization: Bearer`; the browser relies on the httpOnly cookie.
    res.json({ user: { ...user, organizationName: row.organization_name }, token });
  });

  router.post("/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  router.get("/me", requireAuth(deps.jwtSecret), async (req, res) => {
    const { rows } = await deps.pool.query(`SELECT name FROM organizations WHERE id = $1`, [req.user!.organizationId]);
    res.json({ user: { ...req.user, organizationName: rows[0]?.name ?? null } });
  });

  return router;
}
