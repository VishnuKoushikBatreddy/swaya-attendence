/**
 * FULL DATABASE RESET — wipes every collection, then recreates the minimum
 * needed to sign in: one company and one admin user.
 *
 *   npx tsx ... scripts/reset-db.ts           # dry run — shows what would go
 *   npx tsx ... scripts/reset-db.ts --apply   # actually wipe and reseed
 *
 * DESTRUCTIVE. Run scripts/backup-db.ts first.
 *
 * Documents are deleted rather than collections dropped, so the indexes built
 * from the schemas survive the reset and don't have to be rebuilt.
 *
 * Everything else — sites, shifts, schedules, employees — is intentionally NOT
 * seeded: a fresh start means building those through the app.
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { connectDB, disconnectDB } from "../src/lib/db";
import { Company, User } from "../src/models";

const COMPANY = { name: "Swaya", timezone: "Asia/Kolkata" };
const ADMIN = {
  fullName: "Swaya Admin",
  email: process.env.SEED_ADMIN_EMAIL || "vishnu@swayastudio.com",
};

/**
 * Never hardcode the seeded password: this file is committed, so a literal here
 * publishes working credentials for a real account. It lives in .env.local,
 * which is gitignored.
 */
function requireAdminPassword(): string {
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 8) {
    console.error(
      "SEED_ADMIN_PASSWORD is not set (or is under 8 characters).\n" +
        "Add it to .env.local before running this script, e.g.\n" +
        "  SEED_ADMIN_PASSWORD=your-password-here"
    );
    process.exit(1);
  }
  return password;
}

const apply = process.argv.includes("--apply");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");

  console.log(`Database: ${db.databaseName}${apply ? "" : "   (DRY RUN)"}\n`);

  const collections = (await db.listCollections().toArray())
    .map((c) => c.name)
    .sort();

  console.log("── Documents to delete ──────────────────────────────────────");
  let total = 0;
  for (const name of collections) {
    const n = await db.collection(name).countDocuments();
    total += n;
    console.log(`  ${name.padEnd(26)} ${String(n).padStart(6)}`);
  }
  console.log(`  ${"TOTAL".padEnd(26)} ${String(total).padStart(6)}`);

  console.log("\n── Will recreate ────────────────────────────────────────────");
  console.log(`  company : ${COMPANY.name} (${COMPANY.timezone})`);
  console.log(`  admin   : ${ADMIN.email} (password from SEED_ADMIN_PASSWORD)`);

  if (!apply) {
    console.log("\nDRY RUN — nothing changed. Re-run with --apply to commit.\n");
    await disconnectDB();
    return;
  }

  // Resolved only on the --apply path, so a dry run works without the var set.
  const adminPassword = requireAdminPassword();

  console.log("\n── Wiping ───────────────────────────────────────────────────");
  for (const name of collections) {
    const res = await db.collection(name).deleteMany({});
    if (res.deletedCount) console.log(`  ${name.padEnd(26)} -${res.deletedCount}`);
  }

  console.log("\n── Seeding ──────────────────────────────────────────────────");
  const company = await Company.create({ ...COMPANY, isActive: true });
  const admin = await User.create({
    companyId: company._id,
    fullName: ADMIN.fullName,
    email: ADMIN.email,
    passwordHash: await bcrypt.hash(adminPassword, 10),
    role: "admin",
    isActive: true,
  });
  console.log(`  company ${company.name}  [${company._id}]`);
  console.log(`  admin   ${admin.email}  [${admin._id}]`);

  // Prove the seeded credentials actually work before reporting success.
  const check: any = await User.findOne({ email: ADMIN.email })
    .select("+passwordHash")
    .lean();
  const ok = check && (await bcrypt.compare(adminPassword, check.passwordHash));
  console.log(`\n  password verifies: ${ok ? "yes" : "NO — investigate"}`);
  if (!ok) process.exitCode = 1;

  console.log(`\nReset complete. Sign in as ${ADMIN.email} using SEED_ADMIN_PASSWORD.\n`);
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
