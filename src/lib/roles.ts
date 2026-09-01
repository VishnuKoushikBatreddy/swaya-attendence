/**
 * The canonical list of user roles.
 *
 * Deliberately dependency-free: `src/types/next-auth.d.ts` imports this to type
 * the session, and that file must not pull in anything that imports `next-auth`
 * itself — api-helpers does, which would make the augmentation depend on a
 * module that depends on the augmentation.
 *
 * Everything that needs to know the role set reads it from here — the Mongoose
 * enum, the Zod schema on employee creation, the NextAuth session/JWT types, and
 * requireRole. Previously each held its own copy, so a role could be added or
 * removed in one and silently missed in another.
 */
export const ROLES = ["admin", "employee"] as const;

export type Role = (typeof ROLES)[number];

/** Narrowing guard for values arriving from outside the type system (JWT, DB). */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
