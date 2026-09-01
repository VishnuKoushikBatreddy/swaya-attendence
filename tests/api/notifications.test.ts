/**
 * Admin notification feed API.
 *
 * The behaviours that matter: only admins can read it, read state is PER-ADMIN
 * (one admin clearing the feed must not hide alerts from another), and ids from
 * another company cannot be marked read by guessing them.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const ADMIN = { id: "507f1f77bcf86cd799439011", companyId: "507f1f77bcf86cd799439000", role: "admin" };
const OTHER_ADMIN = { id: "507f1f77bcf86cd799439012", companyId: ADMIN.companyId, role: "admin" };
const EMPLOYEE = { id: "507f1f77bcf86cd799439013", companyId: ADMIN.companyId, role: "employee" };

const state = vi.hoisted(() => ({
  user: null as any,
  rows: [] as any[],
  lastFilter: null as any,
  lastUpdate: null as any,
  updateResult: { modifiedCount: 0 },
}));

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => (state.user ? { user: state.user } : null)),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));

vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => {
    const c: any = {
      sort: () => c,
      limit: () => c,
      select: () => c,
      lean: async () => resolve(),
    };
    return c;
  };
  return {
    // requireAuth now re-reads the live account on every request, so the User
    // model must answer. Returning the session's own role keeps these tests
    // about notifications rather than about account state.
    User: {
      findOne: vi.fn(() => chain(() => (state.user ? { _id: state.user.id, role: state.user.role, companyId: state.user.companyId } : null))),
    },
    Notification: {
      find: vi.fn((f: any) => {
        state.lastFilter = f;
        return chain(() => state.rows);
      }),
      countDocuments: vi.fn(async () => state.rows.filter((r) => !(r.readBy || []).length).length),
      updateMany: vi.fn(async (filter: any, update: any) => {
        state.lastUpdate = { filter, update };
        return state.updateResult;
      }),
    },
  };
});

import { GET, PATCH } from "@/app/api/notifications/route";
import { clearActiveUserCache } from "@/lib/active-user";

const req = (url: string, body?: any) =>
  ({
    url,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  }) as any;

beforeEach(() => {
  state.user = ADMIN;
  state.rows = [];
  state.lastFilter = null;
  state.lastUpdate = null;
  state.updateResult = { modifiedCount: 0 };
  // requireAuth caches the live account for ~30s; a stale entry would leak the
  // previous test's role into the next one.
  clearActiveUserCache();
  vi.clearAllMocks();
});

describe("GET /api/notifications", () => {
  it("rejects an employee", async () => {
    state.user = EMPLOYEE;
    const res = await GET(req("http://x/api/notifications"));
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated caller", async () => {
    state.user = null;
    const res = await GET(req("http://x/api/notifications"));
    expect(res.status).toBe(401);
  });

  it("scopes the query to the caller's company", async () => {
    await GET(req("http://x/api/notifications"));
    expect(String(state.lastFilter.companyId)).toBe(ADMIN.companyId);
  });

  it("reports isRead PER ADMIN, not globally", async () => {
    // Read by the OTHER admin only.
    state.rows = [
      { _id: "n1", type: "offline", title: "t", body: "b", readBy: [OTHER_ADMIN.id] },
    ];
    const res = await GET(req("http://x/api/notifications"));
    const { data } = await res.json();
    // Must still be unread for THIS admin.
    expect(data.notifications[0].isRead).toBe(false);

    state.user = OTHER_ADMIN;
    const res2 = await GET(req("http://x/api/notifications"));
    const json2 = await res2.json();
    expect(json2.data.notifications[0].isRead).toBe(true);
  });

  it("never leaks the readBy array to the client", async () => {
    state.rows = [{ _id: "n1", type: "offline", title: "t", body: "b", readBy: [ADMIN.id] }];
    const res = await GET(req("http://x/api/notifications"));
    const { data } = await res.json();
    expect(data.notifications[0]).not.toHaveProperty("readBy");
  });

  it("filters by type", async () => {
    await GET(req("http://x/api/notifications?type=site_exit"));
    expect(state.lastFilter.type).toBe("site_exit");
  });

  it("ignores an unknown type rather than returning nothing", async () => {
    await GET(req("http://x/api/notifications?type=nonsense"));
    expect(state.lastFilter.type).toBeUndefined();
  });

  it("filters to unread for the calling admin", async () => {
    await GET(req("http://x/api/notifications?unread=1"));
    expect(String(state.lastFilter.readBy.$ne)).toBe(ADMIN.id);
  });
});

describe("PATCH /api/notifications", () => {
  it("rejects an employee", async () => {
    state.user = EMPLOYEE;
    const res = await PATCH(req("http://x/api/notifications", { all: true }));
    expect(res.status).toBe(403);
  });

  it("marks all read for this admin only", async () => {
    await PATCH(req("http://x/api/notifications", { all: true }));
    expect(String(state.lastUpdate.update.$addToSet.readBy)).toBe(ADMIN.id);
    expect(String(state.lastUpdate.filter.companyId)).toBe(ADMIN.companyId);
  });

  it("scopes an id-based update to the company", async () => {
    // Without the companyId in the filter, a guessed id from another company
    // would be mutable.
    await PATCH(req("http://x/api/notifications", { ids: ["507f1f77bcf86cd799439099"] }));
    expect(String(state.lastUpdate.filter.companyId)).toBe(ADMIN.companyId);
    expect(state.lastUpdate.filter._id.$in).toHaveLength(1);
  });

  it("rejects a malformed id with 400 rather than throwing a 500", async () => {
    const res = await PATCH(req("http://x/api/notifications", { ids: ["not-an-id"] }));
    expect(res.status).toBe(400);
  });

  it("requires something to act on", async () => {
    const res = await PATCH(req("http://x/api/notifications", {}));
    expect(res.status).toBe(400);
  });

  it("rejects an invalid JSON body", async () => {
    const res = await PATCH(req("http://x/api/notifications"));
    expect(res.status).toBe(400);
  });
});
