/**
 * Role-based access control for admin-only write endpoints.
 * For each route: an employee is forbidden (403), an anonymous caller is
 * unauthenticated (401), and an admin passes authorization (reaching Zod
 * validation -> 400 on an empty body, proving the guard let them through).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ session: null as any }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("@/lib/api-helpers", async (orig) => {
  const actual: any = await orig();
  return {
    ...actual,
    requireAuth: async () => {
      if (!h.session) throw new actual.ApiError("Unauthenticated", 401);
      return h.session;
    },
    requireRole: async (allowed: string[]) => {
      if (!h.session) throw new actual.ApiError("Unauthenticated", 401);
      if (!allowed.includes(h.session.user.role)) {
        throw new actual.ApiError("Forbidden", 403);
      }
      return h.session;
    },
  };
});

import { POST as sitesPost } from "@/app/api/sites/route";
import { POST as shiftsPost } from "@/app/api/shifts/route";
import { POST as schedulesPost } from "@/app/api/schedules/route";
import { POST as employeesPost } from "@/app/api/admin/employees/route";
import { GET as auditGet } from "@/app/api/audit/route";
import { POST as assignmentsPost } from "@/app/api/assignments/route";

const employee = { user: { id: "e1", companyId: "c1", role: "employee" } };
const admin = { user: { id: "a1", companyId: "c1", role: "admin" } };

const req = (body: unknown = {}, url = "http://localhost/api/x") =>
  ({ json: async () => body, headers: new Headers(), url }) as any;

beforeEach(() => {
  h.session = null;
  vi.clearAllMocks();
});

// Routes that parse a Zod body immediately after the role check.
const writeRoutes: Array<[string, (r: any) => Promise<Response>]> = [
  ["POST /api/sites", sitesPost],
  ["POST /api/shifts", shiftsPost],
  ["POST /api/schedules", schedulesPost],
  ["POST /api/admin/employees", employeesPost],
];

describe("admin write endpoints — RBAC", () => {
  for (const [name, handler] of writeRoutes) {
    describe(name, () => {
      it("401 for an anonymous caller", async () => {
        h.session = null;
        expect((await handler(req())).status).toBe(401);
      });
      it("403 for an employee", async () => {
        h.session = employee;
        const res = await handler(req());
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.ok).toBe(false);
        expect(res.headers.get("cache-control")).toContain("no-store");
      });
      it("admin passes authorization (reaches validation -> 400 on empty body)", async () => {
        h.session = admin;
        const res = await handler(req());
        expect(res.status).toBe(400);
      });
    });
  }
});

describe("GET /api/audit — RBAC", () => {
  it("401 anonymous", async () => {
    h.session = null;
    expect((await auditGet(req())).status).toBe(401);
  });
  it("403 employee", async () => {
    h.session = employee;
    expect((await auditGet(req())).status).toBe(403);
  });
});

describe("POST /api/assignments — RBAC", () => {
  it("401 anonymous", async () => {
    h.session = null;
    expect((await assignmentsPost(req())).status).toBe(401);
  });
  it("403 employee", async () => {
    h.session = employee;
    expect((await assignmentsPost(req())).status).toBe(403);
  });
});
