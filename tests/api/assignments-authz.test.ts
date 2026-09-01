/**
 * Authorization and input validation for /api/assignments.
 *
 * Two defects lived here. GET returned every assignment in the company to any
 * signed-in user, and POST wrote whatever siteIds it was handed without checking
 * they belonged to the caller's company — the cross-tenant guard that the
 * sibling /api/schedules route already had.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Types } from "mongoose";

const COMPANY = new Types.ObjectId();
const ADMIN = new Types.ObjectId();
const EMPLOYEE = new Types.ObjectId();
const OWN_SITE = new Types.ObjectId();
const FOREIGN_SITE = new Types.ObjectId();

const state = vi.hoisted(() => ({
  dbUser: null as any,
  /** Users the company owns, for the POST ownership check. */
  ownedUser: null as any,
  /** Sites the company owns, for the POST ownership check. */
  ownedSites: [] as any[],
  created: [] as any[],
  lastFindFilter: null as any,
}));
const h = vi.hoisted(() => ({ session: null as any }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => h.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

vi.mock("@/models", () => {
  const chain = (resolve: () => any): any => {
    const c: any = { sort: () => c, limit: () => c, select: () => c, lean: async () => resolve() };
    return c;
  };
  return {
    User: {
      // active-user.ts uses findOne({ _id, isActive }); the route uses
      // findOne({ _id, companyId }). Distinguish by which key is present.
      findOne: vi.fn((f: any) =>
        chain(() => ("companyId" in (f || {}) ? state.ownedUser : state.dbUser))
      ),
    },
    WorkSite: {
      // Must honour the $in filter: returning the owned set regardless would
      // make a foreign id look owned whenever the counts happened to match.
      find: vi.fn((f: any) => {
        const wanted = (f?._id?.$in ?? []).map((v: any) => String(v));
        return chain(() =>
          state.ownedSites.filter((s: any) => wanted.includes(String(s._id)))
        );
      }),
    },
    EmployeeSiteAssignment: {
      find: vi.fn((f: any) => {
        state.lastFindFilter = f;
        return chain(() => []);
      }),
      updateMany: vi.fn(async () => ({ modifiedCount: 0 })),
      create: vi.fn(async (doc: any) => {
        state.created.push(doc);
        return doc;
      }),
    },
  };
});

import { clearActiveUserCache } from "@/lib/active-user";

const req = (url: string, body?: any) => ({ url, json: async () => body }) as any;

function signIn(role: "admin" | "employee", id: Types.ObjectId) {
  h.session = { user: { id: String(id), companyId: String(COMPANY), role, email: "x@y.com" } };
  state.dbUser = { _id: id, role, companyId: COMPANY };
  clearActiveUserCache();
}

beforeEach(() => {
  state.created = [];
  state.lastFindFilter = null;
  state.ownedUser = { _id: EMPLOYEE, companyId: COMPANY };
  state.ownedSites = [{ _id: OWN_SITE }];
  signIn("admin", ADMIN);
  vi.clearAllMocks();
});

describe("GET /api/assignments", () => {
  it("pins an employee to their OWN assignments", async () => {
    const { GET } = await import("@/app/api/assignments/route");
    signIn("employee", EMPLOYEE);

    await GET(req("http://x/api/assignments"));

    // WAS: no employeeId filter at all, so the response contained every
    // assignment in the company. That leaked who works where, and made the
    // employee's own "My work sites" page list colleagues' sites — it builds
    // its list from whatever this returns.
    expect(String(state.lastFindFilter.employeeId)).toBe(String(EMPLOYEE));
  });

  it("ignores an employeeId an employee tries to supply", async () => {
    const { GET } = await import("@/app/api/assignments/route");
    signIn("employee", EMPLOYEE);

    await GET(`http://x/api/assignments?employeeId=${ADMIN}` as any);
    await GET(req(`http://x/api/assignments?employeeId=${ADMIN}`));

    expect(String(state.lastFindFilter.employeeId)).toBe(String(EMPLOYEE));
  });

  it("lets an admin query a specific employee", async () => {
    const { GET } = await import("@/app/api/assignments/route");
    await GET(req(`http://x/api/assignments?employeeId=${EMPLOYEE}`));
    expect(String(state.lastFindFilter.employeeId)).toBe(String(EMPLOYEE));
  });

  it("always scopes to the caller's company", async () => {
    const { GET } = await import("@/app/api/assignments/route");
    await GET(req("http://x/api/assignments"));
    expect(String(state.lastFindFilter.companyId)).toBe(String(COMPANY));
  });

  it("rejects a malformed employeeId from an admin with 400", async () => {
    const { GET } = await import("@/app/api/assignments/route");
    const res = await GET(req("http://x/api/assignments?employeeId=not-an-id"));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/assignments", () => {
  it("refuses a siteId belonging to another company", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    // The company owns OWN_SITE only, so the lookup cannot match FOREIGN_SITE.
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(EMPLOYEE),
        siteIds: [String(FOREIGN_SITE)],
      })
    );
    expect(res.status).toBe(400);
    expect(state.created).toHaveLength(0);
  });

  it("refuses when only SOME of the sites are owned", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(EMPLOYEE),
        siteIds: [String(OWN_SITE), String(FOREIGN_SITE)],
      })
    );
    expect(res.status).toBe(400);
    // Nothing partially applied.
    expect(state.created).toHaveLength(0);
  });

  it("refuses an employee outside the caller's company", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    state.ownedUser = null; // the company does not own this user
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(new Types.ObjectId()),
        siteIds: [String(OWN_SITE)],
      })
    );
    expect(res.status).toBe(404);
    expect(state.created).toHaveLength(0);
  });

  it("rejects a malformed siteId with 400 rather than a 500", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(EMPLOYEE),
        siteIds: ["not-an-id"],
      })
    );
    expect(res.status).toBe(400);
  });

  it("creates the assignments when everything is owned", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(EMPLOYEE),
        siteIds: [String(OWN_SITE)],
      })
    );
    expect(res.status).toBe(201);
    expect(state.created).toHaveLength(1);
    expect(String(state.created[0].siteId)).toBe(String(OWN_SITE));
    expect(String(state.created[0].companyId)).toBe(String(COMPANY));
    expect(state.created[0].isPrimary).toBe(true);
  });

  it("stays admin-only", async () => {
    const { POST } = await import("@/app/api/assignments/route");
    signIn("employee", EMPLOYEE);
    const res = await POST(
      req("http://x/api/assignments", {
        employeeId: String(EMPLOYEE),
        siteIds: [String(OWN_SITE)],
      })
    );
    expect(res.status).toBe(403);
  });
});
