/**
 * Live account state, checked on every authenticated request.
 *
 * NextAuth issues a 7-day JWT carrying `role` and `companyId`, and those values
 * were previously trusted for the life of the token. Nothing re-read the
 * database, so deactivating, DELETING or demoting a user had no effect for up to
 * a week: a fired employee kept full API access, a demoted admin kept admin
 * access, and a hard-deleted user's token still validated because only the
 * signature was checked. Resetting a password did not end existing sessions
 * either, so the obvious response to a compromise did not actually lock anyone
 * out.
 *
 * The native endpoints already re-checked `isActive` for exactly this reason —
 * their tokens are long-lived. A 7-day session cookie is long-lived too.
 *
 * A lookup per request would land on the hot paths (pings every 5 minutes per
 * employee, the dashboard poll every 15s), so results are cached briefly. That
 * bounds staleness at TTL_MS instead of 7 days, and administrative changes call
 * invalidateActiveUser() to take effect immediately rather than waiting it out.
 */
import { Types } from "mongoose";
import { User } from "@/models";
import { connectDB } from "./db";
import { isRole, type Role } from "./roles";

export type ActiveUser = { role: Role; companyId: string };

/**
 * Deliberately short. It is the maximum window in which a revoked account can
 * still act, so it trades a little database load for a much smaller blast
 * radius — and any change made through the admin UI invalidates immediately.
 */
const TTL_MS = 30_000;

const cache = new Map<string, { value: ActiveUser | null; at: number }>();

/** Drop a cached entry so the next request re-reads the database. */
export function invalidateActiveUser(userId: string): void {
  cache.delete(String(userId));
}

/** Clear the whole cache (tests). */
export function clearActiveUserCache(): void {
  cache.clear();
}

/**
 * The user's CURRENT role and company, or null when the account no longer
 * exists or has been deactivated.
 *
 * Negative results are cached too: a deleted user's token would otherwise hit
 * the database on every single request until it expired.
 */
export async function getActiveUser(userId: string): Promise<ActiveUser | null> {
  const key = String(userId);
  // A token carrying a non-ObjectId id would make findOne throw a CastError,
  // surfacing as a 500 instead of the 401 it actually is.
  if (!Types.ObjectId.isValid(key)) return null;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  await connectDB();
  const doc = await User.findOne({ _id: key, isActive: true })
    .select("role companyId")
    .lean();

  const value: ActiveUser | null = doc
    ? {
        // Same narrowing as the NextAuth callbacks: a value read from the
        // database is outside the type system until checked, and an
        // unrecognised role must never be mistaken for an admin.
        role: isRole(doc.role) ? doc.role : "employee",
        companyId: String(doc.companyId),
      }
    : null;

  cache.set(key, { value, at: Date.now() });
  return value;
}
