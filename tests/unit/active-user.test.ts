/**
 * Live account state behind requireAuth.
 *
 * The point of this module is that a 7-day session cookie is not proof the
 * account still exists, is still active, or still has the role it had at login.
 * What matters here: revoked accounts resolve to null, the cache is short and
 * invalidatable, and a bad id never throws.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Types } from "mongoose";

const state = vi.hoisted(() => ({
  doc: null as any,
  findOneCalls: 0,
}));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => ({
    select: () => chain(resolve),
    lean: async () => resolve(),
  });
  return {
    User: {
      findOne: vi.fn(() => {
        state.findOneCalls++;
        return chain(() => state.doc);
      }),
    },
  };
});

import {
  getActiveUser,
  invalidateActiveUser,
  clearActiveUserCache,
} from "@/lib/active-user";

const ID = new Types.ObjectId();
const COMPANY = new Types.ObjectId();

beforeEach(() => {
  state.doc = { _id: ID, role: "admin", companyId: COMPANY };
  state.findOneCalls = 0;
  clearActiveUserCache();
  vi.clearAllMocks();
});

describe("getActiveUser", () => {
  it("returns the live role and company", async () => {
    const u = await getActiveUser(String(ID));
    expect(u).toEqual({ role: "admin", companyId: String(COMPANY) });
  });

  it("returns null when the account is deactivated or deleted", async () => {
    // The query filters on isActive, so both cases look the same: no document.
    state.doc = null;
    expect(await getActiveUser(String(ID))).toBeNull();
  });

  it("reports the CURRENT role, so a demotion takes effect", async () => {
    expect((await getActiveUser(String(ID)))!.role).toBe("admin");
    state.doc = { _id: ID, role: "employee", companyId: COMPANY };
    invalidateActiveUser(String(ID));
    expect((await getActiveUser(String(ID)))!.role).toBe("employee");
  });

  it("falls back to the least-privileged role for an unrecognised value", async () => {
    // A hand-edited or legacy database value must never be read as admin.
    state.doc = { _id: ID, role: "superuser", companyId: COMPANY };
    expect((await getActiveUser(String(ID)))!.role).toBe("employee");
  });

  it("caches, so the hot paths do not hit the database every request", async () => {
    await getActiveUser(String(ID));
    await getActiveUser(String(ID));
    await getActiveUser(String(ID));
    expect(state.findOneCalls).toBe(1);
  });

  it("caches the NEGATIVE result too", async () => {
    // Otherwise a deleted user's token queries the database on every request
    // until it expires — the cheapest possible denial of service.
    state.doc = null;
    await getActiveUser(String(ID));
    await getActiveUser(String(ID));
    expect(state.findOneCalls).toBe(1);
  });

  it("re-reads immediately after invalidation", async () => {
    await getActiveUser(String(ID));
    invalidateActiveUser(String(ID));
    await getActiveUser(String(ID));
    expect(state.findOneCalls).toBe(2);
  });

  it("returns null for a malformed id instead of throwing", async () => {
    // A forged or corrupt token would otherwise raise a CastError, surfacing as
    // a 500 rather than the 401 it actually is.
    expect(await getActiveUser("not-an-object-id")).toBeNull();
    expect(state.findOneCalls).toBe(0);
  });

  it("keeps separate entries per user", async () => {
    const other = new Types.ObjectId();
    await getActiveUser(String(ID));
    state.doc = { _id: other, role: "employee", companyId: COMPANY };
    expect((await getActiveUser(String(other)))!.role).toBe("employee");
    // The first user's cached entry is untouched.
    expect((await getActiveUser(String(ID)))!.role).toBe("admin");
  });
});
