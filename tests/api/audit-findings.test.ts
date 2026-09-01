/**
 * Regression tests for two defects found in the full-project audit:
 * a revoked account that kept working, and a CSV export that escaped only some
 * of its columns. Each test names the wrong behaviour it replaces.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Types } from "mongoose";

const COMPANY = new Types.ObjectId();
const USER = new Types.ObjectId();

const state = vi.hoisted(() => ({
  days: [] as any[],
  users: [] as any[],
  counts: [] as any[],
  /** The User document the DB would return — null means "deleted". */
  dbUser: null as any,
}));
const h = vi.hoisted(() => ({ session: null as any }));

vi.mock("@/lib/db", () => ({ connectDB: vi.fn(async () => ({})) }));
vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => h.session),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

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
    AttendanceDay: { find: vi.fn(() => chain(() => state.days)) },
    User: {
      find: vi.fn(() => chain(() => state.users)),
      findOne: vi.fn(() => chain(() => state.dbUser)),
      findById: vi.fn(() => chain(() => state.dbUser)),
    },
    AttendanceSession: { aggregate: vi.fn(async () => state.counts) },
    AuditLog: { find: vi.fn(() => chain(() => [])) },
  };
});

import { clearActiveUserCache } from "@/lib/active-user";

const req = (url: string) => ({ url }) as any;

/** Count CSV fields the way a real parser does — a comma inside quotes is data. */
function countFields(line: string): number {
  let fields = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i++; // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields++;
    }
  }
  return fields;
}

beforeEach(() => {
  state.days = [];
  state.users = [];
  state.counts = [];
  // Active by default; individual tests revoke it.
  state.dbUser = { _id: USER, role: "admin", companyId: COMPANY };
  clearActiveUserCache();
  h.session = {
    user: {
      id: String(USER),
      companyId: String(COMPANY),
      role: "admin",
      email: "a@x.com",
    },
  };
  vi.clearAllMocks();
});

describe("revoked accounts lose access immediately", () => {
  it("rejects an admin whose account has been deactivated", async () => {
    const { GET } = await import("@/app/api/audit/route");

    // The account is disabled in the database...
    state.dbUser = null; // findOne({ isActive: true }) matches nothing
    clearActiveUserCache();

    // WAS: the JWT minted before that still said "admin", and requireRole read
    // ONLY the token — no database lookup — so the request succeeded. Sessions
    // last 7 days, so deactivating, DELETING or demoting a user had no effect
    // for up to a week. requireAuth now re-reads the live account.
    const res = await GET(req("http://x/api/audit"));
    expect(res.status, "deactivated admin still reached an admin endpoint").toBe(401);
  });
});

describe("CSV export escapes every column", () => {
  async function exportCsv(user: any) {
    const { GET } = await import("@/app/api/reports/attendance/route");
    state.days = [
      {
        _id: "d1",
        employeeId: "u1",
        workDate: "2026-06-13",
        status: "present",
        firstCheckInAt: null,
        lastCheckOutAt: null,
        totalWorkSeconds: 0,
      },
    ];
    state.users = [{ _id: "u1", ...user }];
    const res = await GET(req("http://x/api/reports/attendance?format=csv"));
    return res.text();
  }

  it("neutralises a formula in the employee CODE", async () => {
    // WAS: employeeCode (arbitrary admin-supplied text, z.string().max(40)) was
    // written to the CSV unescaped, so opening the export in Excel or Sheets
    // executed it. Only employeeName and flagReasons went through csvEscape.
    const csv = await exportCsv({
      fullName: "Alice",
      employeeCode: "=1+1",
      email: "alice@x.com",
    });
    const dataRow = csv.split("\n")[1];
    expect(dataRow, `unescaped formula in CSV: ${dataRow}`).not.toMatch(/,=1\+1,/);
  });

  it("does not let a comma in the employee code shift every later column", async () => {
    // Independent of security: an unquoted comma silently corrupts the row, so
    // "Work (sec)" ends up reading whatever landed in the next cell along.
    const csv = await exportCsv({
      fullName: "Alice",
      employeeCode: "A,B",
      email: "alice@x.com",
    });
    const [headerLine, dataLine] = csv.split("\n");
    expect(
      countFields(dataLine),
      `row does not line up with the header: ${dataLine}`
    ).toBe(countFields(headerLine));
    // The comma must survive as DATA inside a quoted field, not split the row.
    expect(dataLine).toContain('"A,B"');
  });
});
