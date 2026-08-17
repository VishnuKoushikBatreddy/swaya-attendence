/**
 * Server-side helpers for API routes.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "./auth";
import { connectDB } from "./db";

export type Role = "super_admin" | "admin" | "manager" | "employee";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// Every API response is per-user, request-specific data — never cache it. Without
// this, the browser/edge can serve a stale copy of a GET /api/... response on a
// soft refresh, which is why changes sometimes need several refreshes to appear.
const NO_STORE = "no-store, max-age=0, must-revalidate";

export function ok<T>(data: T, init?: ResponseInit) {
  const res = NextResponse.json({ ok: true, data }, init);
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

export function fail(message: string, status = 400, extra?: object) {
  const res = NextResponse.json(
    { ok: false, error: message, ...(extra ?? {}) },
    { status }
  );
  res.headers.set("Cache-Control", NO_STORE);
  return res;
}

export async function requireAuth() {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new ApiError("Unauthenticated", 401);
  return session;
}

export async function requireRole(allowed: Role[]) {
  const session = await requireAuth();
  if (!allowed.includes(session.user.role as Role)) {
    throw new ApiError("Forbidden", 403);
  }
  return session;
}

export async function parseJson<T>(req: NextRequest, schema: { parse: (v: unknown) => T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError("Invalid JSON body", 400);
  }
  return schema.parse(body);
}

/** Wrap an API route handler so thrown ApiErrors become proper JSON responses. */
export function withApi<TArgs extends unknown[]>(
  fn: (...args: TArgs) => Promise<Response>
) {
  return async (...args: TArgs): Promise<Response> => {
    try {
      await connectDB();
      return await fn(...args);
    } catch (err) {
      if (err instanceof ApiError) return fail(err.message, err.status);
      // Zod errors -> 400
      if (err && typeof err === "object" && "issues" in err) {
        return fail("Validation failed", 400, { issues: (err as { issues: unknown }).issues });
      }
      const e = err as { name?: string; code?: number };
      // Mongoose cast (bad ObjectId etc.) -> 400, not a 500.
      if (e?.name === "CastError") return fail("Invalid identifier", 400);
      // Mongo duplicate-key (unique index) -> 409, not a 500.
      if (e?.code === 11000) return fail("Already exists", 409);
      // eslint-disable-next-line no-console
      console.error("[api] unhandled error:", err);
      const message = err instanceof Error ? err.message : "Internal server error";
      return fail(message, 500);
    }
  };
}
