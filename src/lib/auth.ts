/** Login, sessions, and team management. Mirrors the Python auth.py.
 *
 * Passwords are never stored in the clear — only a scrypt hash + per-user salt sit
 * in Postgres. Sessions live in the Session table so a server restart doesn't force
 * everyone to log in again (an upgrade over the Python version's in-memory sessions).
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { prisma } from "./db";
import { log } from "./store";

export const INVITE_DOMAIN = "@contentninja.in";
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export const ROLES = ["viewer", "editor", "admin", "super-admin"] as const;
export type Role = (typeof ROLES)[number];
export const VIEW_ROLES = new Set<Role>(["viewer", "editor", "admin", "super-admin"]);
export const MUTATE_ROLES = new Set<Role>(["editor", "admin", "super-admin"]);
export const SETTINGS_ROLES = new Set<Role>(["admin", "super-admin"]);
export const SUPERADMIN_ROLES = new Set<Role>(["super-admin"]);

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SessionInfo {
  userId: string;
  email: string;
  role: Role;
}

// --- passwords --------------------------------------------------------------
export function hashPassword(password: string, saltHex?: string) {
  const salt = saltHex ?? randomBytes(16).toString("hex");
  const digest = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
  return { salt, digest };
}

export function verifyPassword(password: string, saltHex: string, digestHex: string) {
  const { digest } = hashPassword(password, saltHex);
  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(digestHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkPasswordStrength(password: string) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

// --- bootstrap ---------------------------------------------------------------
export async function ensureSuperAdmin() {
  const email = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !password) {
    await log("warn", "auth", "No SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD set — no login possible yet");
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;

  const { salt, digest } = hashPassword(password);
  await prisma.user.create({
    data: { email, role: "super-admin", passwordSalt: salt, passwordHash: digest },
  });
  await log("info", "auth", `Seeded super admin account for ${email}`);
}

// --- lookups -------------------------------------------------------------
export function findUser(email: string) {
  return prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
}

export function findUserById(id: string) {
  return prisma.user.findUnique({ where: { id } });
}

export function publicUser(u: {
  id: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: Date;
  createdBy: string | null;
  lastLoginAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt.toISOString(),
    createdBy: u.createdBy,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
  };
}

// --- sessions ------------------------------------------------------------
export async function login(
  email: string,
  password: string
): Promise<{ token: string; email: string; role: Role } | { error: string }> {
  const user = await findUser(email);
  if (!user || !user.active) return { error: "Invalid email or password." };
  if (!verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return { error: "Invalid email or password." };
  }

  const token = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: {
      token,
      userId: user.id,
      email: user.email,
      role: user.role,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await log("info", "auth", `${user.email} logged in`, { user: user.email });
  return { token, email: user.email, role: user.role as Role };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const sess = await prisma.session.findUnique({ where: { token } });
  if (!sess) return;
  await prisma.session.delete({ where: { token } });
  await log("info", "auth", `${sess.email} logged out`, { user: sess.email });
}

export async function sessionFor(token: string | undefined): Promise<SessionInfo | null> {
  if (!token) return null;
  const sess = await prisma.session.findUnique({ where: { token } });
  if (!sess) return null;
  if (sess.expiresAt.getTime() < Date.now()) {
    await prisma.session.delete({ where: { token } }).catch(() => {});
    return null;
  }
  return { userId: sess.userId, email: sess.email, role: sess.role as Role };
}

export function requireRole(session: SessionInfo | null, allowed: Set<Role>) {
  if (!session) throw new AuthError(401, "Log in to continue.");
  if (!allowed.has(session.role)) throw new AuthError(403, "You don't have permission to do that.");
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string) {
  const user = await findUserById(userId);
  if (!user) throw new AuthError(401, "Log in to continue.");
  if (!verifyPassword(currentPassword, user.passwordSalt, user.passwordHash)) {
    throw new AuthError(400, "Current password is incorrect.");
  }
  checkPasswordStrength(newPassword);
  const { salt, digest } = hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordSalt: salt, passwordHash: digest } });
  await log("info", "auth", `${user.email} changed their password`, { user: user.email });
}

// --- team management (super-admin only, enforced by the caller) ---------
export async function inviteUser(inviterEmail: string, emailRaw: string, role: string, password: string) {
  const email = (emailRaw || "").trim().toLowerCase();
  if (!email.endsWith(INVITE_DOMAIN)) {
    throw new AuthError(400, `Invited emails must end with ${INVITE_DOMAIN}`);
  }
  if (!ROLES.includes(role as Role)) throw new AuthError(400, "Invalid role.");
  if (await findUser(email)) throw new AuthError(400, "A user with that email already exists.");
  checkPasswordStrength(password);

  const { salt, digest } = hashPassword(password);
  const user = await prisma.user.create({
    data: { email, role, passwordSalt: salt, passwordHash: digest, createdBy: inviterEmail },
  });
  await log("info", "team", `${inviterEmail} invited ${email} as ${role}`, { user: inviterEmail });
  return publicUser(user);
}

export async function updateUser(
  actorEmail: string,
  userId: string,
  fields: { role?: string; password?: string; active?: boolean }
) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError(404, "Unknown user.");
  if (user.role === "super-admin" && ((fields.role && fields.role !== "super-admin") || fields.active === false)) {
    throw new AuthError(400, "Can't change the super admin's role or deactivate them.");
  }

  const data: Record<string, unknown> = {};
  const changes: string[] = [];
  if (fields.role && fields.role !== user.role) {
    if (!ROLES.includes(fields.role as Role)) throw new AuthError(400, "Invalid role.");
    data.role = fields.role;
    changes.push(`role → ${fields.role}`);
  }
  if (fields.password) {
    checkPasswordStrength(fields.password);
    const { salt, digest } = hashPassword(fields.password);
    data.passwordSalt = salt;
    data.passwordHash = digest;
    changes.push("password reset");
  }
  if (fields.active !== undefined && fields.active !== user.active) {
    data.active = fields.active;
    changes.push(fields.active ? "activated" : "deactivated");
  }

  const updated = Object.keys(data).length
    ? await prisma.user.update({ where: { id: userId }, data })
    : user;

  if (fields.active === false) {
    await prisma.session.deleteMany({ where: { userId } });
  }
  if (changes.length) {
    await log("info", "team", `${actorEmail} updated ${updated.email}: ${changes.join(", ")}`, { user: actorEmail });
  }
  return publicUser(updated);
}

export async function deleteUser(actorEmail: string, userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AuthError(404, "Unknown user.");
  if (user.role === "super-admin") throw new AuthError(400, "Can't remove the super admin account.");
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await log("warn", "team", `${actorEmail} removed ${user.email}`, { user: actorEmail });
}

export async function listUsers() {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  return users.map(publicUser);
}
