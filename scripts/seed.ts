/**
 * Manual seed script: `npm run seed`
 * Creates a demo company, admin, employees, sites, and a shift.
 * Useful for local dev. Idempotent: only seeds if no data exists.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Lightweight .env.local loader — Next.js loads it for the dev server,
// but tsx scripts run under bare Node and don't. MUST run before any
// module that captures process.env at import time.
function loadDotenvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotenvLocal();

import { connectDB, disconnectDB } from "../src/lib/db";
import {
  Company,
  EmployeeSiteAssignment,
  ShiftTemplate,
  User,
  WorkSite,
} from "../src/models";
import bcrypt from "bcryptjs";

async function main() {
  await connectDB();
  if ((await User.countDocuments()) > 0) {
    console.log("DB already seeded; skipping.");
    await disconnectDB();
    return;
  }

  const password = await bcrypt.hash("password123", 10);

  const company = await Company.create({
    name: "Demo Co",
    timezone: "Asia/Kolkata",
    isActive: true,
  });

  const admin = await User.create({
    companyId: company._id,
    fullName: "Admin User",
    email: "admin@demo.com",
    passwordHash: password,
    role: "admin",
    isActive: true,
  });


  const employees = await User.insertMany([
    {
      companyId: company._id,
      fullName: "Alice Employee",
      email: "alice@demo.com",
      passwordHash: password,
      role: "employee",
      employeeCode: "E001",
      department: "Engineering",
      designation: "Engineer",
      isActive: true,
    },
    {
      companyId: company._id,
      fullName: "Bob Employee",
      email: "bob@demo.com",
      passwordHash: password,
      role: "employee",
      employeeCode: "E002",
      department: "Engineering",
      designation: "Engineer",
      isActive: true,
    },
  ]);

  const site = await WorkSite.create({
    companyId: company._id,
    name: "Main Office",
    address: "123 Demo St",
    location: { type: "Point", coordinates: [77.594566, 12.971599] },
    radiusMeters: 200,
    allowedAccuracyMeters: 50,
  });

  await EmployeeSiteAssignment.insertMany(
    employees.map((e: { _id: typeof company._id }) => ({
      companyId: company._id,
      employeeId: e._id,
      siteId: site._id,
      isActive: true,
      isPrimary: true,
    }))
  );

  await ShiftTemplate.create({
    companyId: company._id,
    name: "Day",
    startTime: "09:30",
    endTime: "18:30",
    graceMinutes: 10,
    minimumWorkMinutes: 480,
    isActive: true,
  });


  console.log("Seeded:");
  console.log("  Company:", company.name, "id:", company._id);
  console.log("  Admin   → admin@demo.com   / password123");
  console.log("  Employee→ alice@demo.com   / password123");
  console.log("  Site:    Main Office (lat=12.971599, lng=77.594566, radius=200m)");
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
