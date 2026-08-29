/**
 * The Cypress seed deletes EVERY DOCUMENT in the target database. It used to
 * default MONGODB_DB_NAME to "attendance" — production — so running the e2e
 * suite on a machine with a real MONGODB_URI in .env.local would destroy live
 * data with no warning.
 *
 * This pins the name check that now guards it. The regex is duplicated here
 * deliberately: importing cypress/support/seed.ts would connect to Mongo at
 * module load, which a unit test must not do.
 */
import { describe, it, expect } from "vitest";

const THROWAWAY_NAME = /(^|[_-])(test|tests|ci|e2e|cypress|sandbox)([_-]|$)/i;
const allowed = (name: string) => THROWAWAY_NAME.test(name);

describe("cypress seed database guard", () => {
  it("REFUSES the production database name", () => {
    expect(allowed("attendance")).toBe(false);
  });

  it("refuses other real-looking names", () => {
    for (const n of ["prod", "attendance_prod", "swaya", "main", "app", "live"]) {
      expect(allowed(n)).toBe(false);
    }
  });

  it("refuses a name that merely contains the letters, not the word", () => {
    // "attendance" contains "ci"? No — but these near-misses must not slip by.
    for (const n of ["attendancetest", "citrus", "testing123", "protest"]) {
      expect(allowed(n)).toBe(false);
    }
  });

  it("allows explicitly disposable names", () => {
    for (const n of [
      "attendance_ci",
      "attendance_test",
      "attendance-e2e",
      "test_attendance",
      "cypress_db",
      "attendance_sandbox",
      "ci",
      "test",
    ]) {
      expect(allowed(n)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(allowed("Attendance_CI")).toBe(true);
    expect(allowed("ATTENDANCE")).toBe(false);
  });

  it("treats an unset name as unsafe", () => {
    expect(allowed("")).toBe(false);
  });
});
