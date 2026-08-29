/**
 * Reusable multi-company seed for DB-backed integration tests.
 *
 * Creates TWO companies, each with an admin, an employee, a site, a shift, and a
 * schedule, so cross-company isolation can be exercised. Only used by opt-in
 * integration tests (RUN_DB_TESTS=1) against a THROWAWAY database.
 */
import { Types } from "mongoose";
import bcrypt from "bcryptjs";
import {
  Company,
  User,
  WorkSite,
  ShiftTemplate,
  EmployeeSiteAssignment,
  EmployeeSchedule,
  AttendanceDay,
  AttendanceSession,
  AttendanceEvent,
  LocationPing,
  GeofenceEvent,
  OutsideSiteLog,
} from "@/models";

export type SeededCompany = {
  companyId: Types.ObjectId;
  adminId: Types.ObjectId;
  employeeId: Types.ObjectId;
  siteId: Types.ObjectId;
  shiftId: Types.ObjectId;
  center: { lat: number; lng: number };
};

export type SeedResult = { a: SeededCompany; b: SeededCompany };

async function seedOne(
  name: string,
  center: { lat: number; lng: number }
): Promise<SeededCompany> {
  const companyId = new Types.ObjectId();
  await Company.create({ _id: companyId, name, timezone: "Asia/Kolkata" });

  const passwordHash = await bcrypt.hash("password123", 10);
  const admin = await User.create({
    companyId,
    fullName: `${name} Admin`,
    email: `admin@${name.toLowerCase()}.test`,
    passwordHash,
    role: "admin",
    isActive: true,
  });
  const employee = await User.create({
    companyId,
    fullName: `${name} Employee`,
    email: `emp@${name.toLowerCase()}.test`,
    passwordHash,
    role: "employee",
    employeeCode: `${name}-001`,
    isActive: true,
  });
  const site = await WorkSite.create({
    companyId,
    name: `${name} HQ`,
    location: { type: "Point", coordinates: [center.lng, center.lat] },
    radiusMeters: 50,
    isActive: true,
  });
  const shift = await ShiftTemplate.create({
    companyId,
    name: "Day",
    startTime: "09:00",
    endTime: "18:00",
    graceMinutes: 10,
    minimumWorkMinutes: 480,
  });
  await EmployeeSiteAssignment.create({
    companyId,
    employeeId: employee._id,
    siteId: site._id,
    isActive: true,
    isPrimary: true,
  });
  await EmployeeSchedule.create({
    companyId,
    employeeId: employee._id,
    siteId: site._id,
    shiftTemplateId: shift._id,
    workDate: "2026-06-15",
    isWorkingDay: true,
  });

  return {
    companyId,
    adminId: admin._id,
    employeeId: employee._id,
    siteId: site._id,
    shiftId: shift._id,
    center,
  };
}

export async function seedTwoCompanies(): Promise<SeedResult> {
  const a = await seedOne("Alpha", { lat: 12.9153, lng: 77.6428 });
  const b = await seedOne("Bravo", { lat: 13.0827, lng: 80.2707 });
  return { a, b };
}

export async function cleanupCompanies(ids: Types.ObjectId[]) {
  const f = { companyId: { $in: ids } };
  await Promise.all([
    Company.deleteMany({ _id: { $in: ids } }),
    User.deleteMany(f),
    WorkSite.deleteMany(f),
    ShiftTemplate.deleteMany(f),
    EmployeeSiteAssignment.deleteMany(f),
    EmployeeSchedule.deleteMany(f),
    // Everything the attendance flow writes. These were missing, so each run
    // left geofence events and the audit ledger behind in the test database.
    AttendanceDay.deleteMany(f),
    AttendanceSession.deleteMany(f),
    AttendanceEvent.deleteMany(f),
    LocationPing.deleteMany(f),
    GeofenceEvent.deleteMany(f),
    OutsideSiteLog.deleteMany(f),
  ]);
}
