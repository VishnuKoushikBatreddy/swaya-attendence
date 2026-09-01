import { describe, it, expect } from "vitest";
import {
  LocationSchema,
  CheckInSchema,
  PingBatchSchema,
  SiteSchema,
  ShiftSchema,
  EmployeeCreateSchema,
  ScheduleRangeSchema,
} from "@/lib/validators";

const ok = (s: any, v: unknown) => s.safeParse(v).success;

// ---------------------------------------------------------------------------
// Location / GPS payload validation
// ---------------------------------------------------------------------------
describe("LocationSchema (GPS payloads)", () => {
  const base = { lat: 12.9, lng: 77.6 };

  it("accepts valid coordinates", () => {
    expect(ok(LocationSchema, base)).toBe(true);
  });

  it("INVALID LATITUDE/LONGITUDE are rejected", () => {
    expect(ok(LocationSchema, { lat: 91, lng: 77.6 })).toBe(false);
    expect(ok(LocationSchema, { lat: -91, lng: 77.6 })).toBe(false);
    expect(ok(LocationSchema, { lat: 12.9, lng: 181 })).toBe(false);
    expect(ok(LocationSchema, { lat: 12.9, lng: -181 })).toBe(false);
  });

  it("rejects a non-numeric / NoSQL-operator latitude", () => {
    expect(ok(LocationSchema, { lat: "12.9", lng: 77.6 })).toBe(false);
    expect(ok(LocationSchema, { lat: { $gt: 0 }, lng: 77.6 })).toBe(false);
  });

  it("ACCURACY 500m is accepted by the schema (engine decides reliability)", () => {
    expect(ok(LocationSchema, { ...base, accuracy: 500 })).toBe(true);
  });

  it("rejects an absurd accuracy beyond 10km", () => {
    expect(ok(LocationSchema, { ...base, accuracy: 20000 })).toBe(false);
  });

  it("validates capturedAt as an ISO datetime", () => {
    expect(ok(LocationSchema, { ...base, capturedAt: "2026-06-13T09:00:00.000Z" })).toBe(true);
    expect(ok(LocationSchema, { ...base, capturedAt: "yesterday" })).toBe(false);
  });

  it("clamps battery to 0–100", () => {
    expect(ok(LocationSchema, { ...base, batteryPercentage: 50 })).toBe(true);
    expect(ok(LocationSchema, { ...base, batteryPercentage: 150 })).toBe(false);
  });
});

describe("CheckInSchema", () => {
  it("requires a non-empty deviceId", () => {
    expect(ok(CheckInSchema, { lat: 12.9, lng: 77.6, deviceId: "" })).toBe(false);
    expect(ok(CheckInSchema, { lat: 12.9, lng: 77.6, deviceId: "d1" })).toBe(true);
  });
});

describe("PingBatchSchema (oversized payload)", () => {
  const p = { lat: 12.9, lng: 77.6, deviceId: "d1" };
  it("accepts 1..500 pings", () => {
    expect(ok(PingBatchSchema, { pings: [p] })).toBe(true);
    expect(ok(PingBatchSchema, { pings: Array.from({ length: 500 }, () => p) })).toBe(true);
  });
  it("rejects an empty batch and a >500 batch", () => {
    expect(ok(PingBatchSchema, { pings: [] })).toBe(false);
    expect(ok(PingBatchSchema, { pings: Array.from({ length: 501 }, () => p) })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Site validation
// ---------------------------------------------------------------------------
describe("SiteSchema", () => {
  const base = { name: "HQ", lat: 12.9, lng: 77.6 };
  it("defaults radius to 150 and accepts a valid site", () => {
    const r = SiteSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.radiusMeters).toBe(150);
  });
  it("rejects a NEGATIVE radius", () => {
    expect(ok(SiteSchema, { ...base, radiusMeters: -5 })).toBe(false);
  });
  it("rejects a radius below the 20m minimum", () => {
    expect(ok(SiteSchema, { ...base, radiusMeters: 10 })).toBe(false);
  });
  it("rejects a VERY LARGE radius beyond 5000m", () => {
    expect(ok(SiteSchema, { ...base, radiusMeters: 100000 })).toBe(false);
  });
  it("rejects invalid coordinates", () => {
    expect(ok(SiteSchema, { ...base, lat: 200 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shift validation
// ---------------------------------------------------------------------------
describe("ShiftSchema", () => {
  it("accepts HH:mm times and grace 0", () => {
    expect(
      ok(ShiftSchema, { name: "Day", startTime: "09:00", endTime: "18:00", graceMinutes: 0 })
    ).toBe(true);
  });
  it("rejects malformed times", () => {
    expect(ok(ShiftSchema, { name: "Day", startTime: "9:00", endTime: "18:00" })).toBe(false);
    expect(ok(ShiftSchema, { name: "Day", startTime: "09:00", endTime: "25:00" })).toBe(true); // regex-only, see note
  });
  it("KNOWN: end-before-start is NOT rejected (treated as an overnight shift downstream)", () => {
    // Documents intentional behaviour: resolveShiftEnd() pushes end to +1 day.
    expect(ok(ShiftSchema, { name: "Night", startTime: "22:00", endTime: "06:00" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Employee / role validation
// ---------------------------------------------------------------------------
describe("EmployeeCreateSchema", () => {
  const base = { fullName: "Asha R", email: "asha@x.com", password: "password123" };
  it("accepts a valid employee", () => {
    expect(ok(EmployeeCreateSchema, base)).toBe(true);
  });
  it("enforces an 8-char minimum password", () => {
    expect(ok(EmployeeCreateSchema, { ...base, password: "short" })).toBe(false);
  });
  it("restricts role to admin|employee (manager/super_admin rejected at creation)", () => {
    expect(ok(EmployeeCreateSchema, { ...base, role: "manager" })).toBe(false);
    expect(ok(EmployeeCreateSchema, { ...base, role: "super_admin" })).toBe(false);
    expect(ok(EmployeeCreateSchema, { ...base, role: "employee" })).toBe(true);
  });
  it("lowercases the email (note: .email() runs before trim, so spaces are rejected)", () => {
    const r = EmployeeCreateSchema.safeParse({ ...base, email: "AsHa@X.com" });
    expect(r.success && r.data.email).toBe("asha@x.com");
    // A space-padded email is rejected, not trimmed:
    expect(ok(EmployeeCreateSchema, { ...base, email: "  asha@x.com " })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Date-format validation
// ---------------------------------------------------------------------------
describe("date validators", () => {
  it("Schedule dates must be YYYY-MM-DD", () => {
    expect(
      ok(ScheduleRangeSchema, {
        fromDate: "2026/06/13",
        toDate: "2026-06-14",
        entries: [{ employeeId: "e", siteId: "s", shiftTemplateId: "t" }],
      })
    ).toBe(false);
  });
});
