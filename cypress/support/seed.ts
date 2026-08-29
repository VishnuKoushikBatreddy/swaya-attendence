/**
 * Test seed — populates Mongo with a known company + admin + manager + 2 employees + 1 site.
 * Idempotent (cleans first). Invoked via cy.task('seed') in tests.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// Load .env.local before reading process.env — Cypress runs this in a bare
// Node process that doesn't auto-load Next.js env files.
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

const MONGODB_URI = process.env.MONGODB_URI || "";
// NOTE: no default. MONGODB_DB_NAME used to fall back to "attendance", which is
// the production database name — see assertThrowawayDatabase below.
const MONGODB_DB = process.env.MONGODB_DB_NAME || "";

/** A database name must look unmistakably disposable to be wiped. */
const THROWAWAY_NAME = /(^|[_-])(test|tests|ci|e2e|cypress|sandbox)([_-]|$)/i;

/**
 * Refuse to touch anything that isn't clearly a throwaway database.
 *
 * Both seed() and cleanup() below delete EVERY DOCUMENT IN EVERY COLLECTION.
 * MONGODB_DB_NAME previously defaulted to "attendance" — the production
 * database — so `npm run e2e` on a machine with a real MONGODB_URI in
 * .env.local would silently destroy live attendance data. The URI is loaded
 * from .env.local automatically a few lines above, so this needed no unusual
 * setup to happen; it just needed someone to run the e2e suite.
 *
 * Failing loudly with instructions is the only safe default here: there is no
 * way to tell a "safe" database from a real one except by name.
 */
function assertThrowawayDatabase(name: string) {
  if (!name) {
    throw new Error(
      "MONGODB_DB_NAME is not set.\n" +
        "The Cypress seed DELETES EVERY DOCUMENT in the target database, so it " +
        "refuses to guess.\n" +
        "Run against a throwaway database, e.g.:\n" +
        "  MONGODB_DB_NAME=attendance_ci npm run e2e"
    );
  }
  if (!THROWAWAY_NAME.test(name)) {
    throw new Error(
      `Refusing to seed "${name}": the Cypress seed DELETES EVERY DOCUMENT in ` +
        "the target database and this name does not look like a throwaway.\n" +
        "Use a name containing test / ci / e2e / cypress / sandbox, e.g.:\n" +
        "  MONGODB_DB_NAME=attendance_ci npm run e2e"
    );
  }
}

let connected = false;

async function connect() {
  if (connected) return;
  if (!MONGODB_URI) throw new Error("MONGODB_URI is required for seed task");
  assertThrowawayDatabase(MONGODB_DB);
  mongoose.set("strictQuery", true);
  await mongoose.connect(MONGODB_URI, { dbName: MONGODB_DB, serverSelectionTimeoutMS: 30000 });
  connected = true;
}

export async function seed() {
  await connect();
  const db = mongoose.connection.db!;
  // clear all collections
  const collections = await db.collections();
  for (const c of collections) await c.deleteMany({});

  const password = await bcrypt.hash("password123", 10);

  // Company
  const company = {
    _id: new mongoose.Types.ObjectId(),
    name: "Test Co",
    timezone: "Asia/Kolkata",
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection("companies").insertOne(company);

  // Users
  const users: Array<{
    _id: mongoose.Types.ObjectId;
    companyId: mongoose.Types.ObjectId;
    fullName: string;
    email: string;
    passwordHash: string;
    role: string;
    isActive: boolean;
    managerId?: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
  }> = [
    { fullName: "Admin User", email: "admin@demo.com", role: "admin" },
    { fullName: "Manager User", email: "manager@demo.com", role: "manager" },
    { fullName: "Alice Employee", email: "alice@demo.com", role: "employee" },
    { fullName: "Bob Employee", email: "bob@demo.com", role: "employee" },
  ].map((u) => ({
    _id: new mongoose.Types.ObjectId(),
    companyId: company._id,
    fullName: u.fullName,
    email: u.email,
    passwordHash: password,
    role: u.role,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  // Set manager
  users[2].managerId = users[1]._id;
  users[3].managerId = users[1]._id;
  await db.collection("users").insertMany(users);

  // Site
  const site = {
    _id: new mongoose.Types.ObjectId(),
    companyId: company._id,
    name: "Main Office",
    address: "123 Test St",
    location: { type: "Point", coordinates: [77.594566, 12.971599] },
    radiusMeters: 200,
    allowedAccuracyMeters: 50,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db.collection("worksites").insertOne(site);

  // Assign both employees
  await db.collection("employeesiteassignments").insertMany(
    [users[2], users[3]].map((u) => ({
      _id: new mongoose.Types.ObjectId(),
      companyId: company._id,
      employeeId: u._id,
      siteId: site._id,
      validFrom: new Date(),
      isActive: true,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  );

  // Shift
  await db.collection("shifttemplates").insertOne({
    _id: new mongoose.Types.ObjectId(),
    companyId: company._id,
    name: "Day",
    startTime: "09:30",
    endTime: "18:30",
    graceMinutes: 10,
    minimumWorkMinutes: 480,
    isNightShift: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { ok: true, companyId: String(company._id), siteId: String(site._id) };
}

export async function cleanup() {
  await connect();
  const db = mongoose.connection.db!;
  const collections = await db.collections();
  for (const c of collections) await c.deleteMany({});
  return { ok: true };
}
