/**
 * Replace the existing admin account with a new one.
 *
 *   npx tsx scripts/replace-admin.ts            # dry run — lists what WOULD change
 *   npx tsx scripts/replace-admin.ts --apply    # actually deletes + creates
 *
 * Deletes every user with role "admin" and creates a fresh admin in the same
 * company. super_admin accounts are left untouched (reported only).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Same lightweight .env.local loader as scripts/seed.ts — tsx runs under bare
// Node, which doesn't pick up .env.local the way the Next.js dev server does.
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
import { Company, User } from "../src/models";
import bcrypt from "bcryptjs";

const NEW_ADMIN = {
  fullName: "Swaya Admin",
  email: process.env.SEED_ADMIN_EMAIL || "vishnu@swayastudio.com",
};

/**
 * Never hardcode the password: this file is committed, so a literal here
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

  const companies = await Company.find().lean();
  // Models are loosely typed (see src/models/index.ts), so annotate locally.
  const admins: any[] = await User.find({ role: "admin" }).lean();
  const superAdmins = await User.find({ role: "super_admin" }).lean();

  console.log(`\nCompanies (${companies.length}):`);
  for (const c of companies) console.log(`  - ${c.name}  [${c._id}]`);

  console.log(`\nExisting admin accounts (${admins.length}):`);
  for (const a of admins) {
    console.log(`  - ${a.email}  "${a.fullName}"  company=${a.companyId}  active=${a.isActive}`);
  }
  if (superAdmins.length) {
    console.log(`\nsuper_admin accounts (left untouched, ${superAdmins.length}):`);
    for (const s of superAdmins) console.log(`  - ${s.email}`);
  }

  // Anything referencing an admin as their manager would be left dangling.
  const orphanCount = admins.length
    ? await User.countDocuments({ managerId: { $in: admins.map((a) => a._id) } })
    : 0;
  if (orphanCount > 0) {
    console.log(
      `\n  WARNING: ${orphanCount} user(s) have one of these admins as managerId; ` +
        `their managerId will be set to null.`
    );
  }

  // Pick the company for the new admin.
  const companyIds = [...new Set(admins.map((a) => String(a.companyId)))];
  let targetCompanyId: unknown;
  if (companyIds.length === 1) {
    targetCompanyId = admins[0].companyId;
  } else if (companyIds.length > 1) {
    console.error(
      `\nAdmins span ${companyIds.length} companies — ambiguous. ` +
        `Pick one and hardcode it before running with --apply.`
    );
    await disconnectDB();
    process.exit(1);
  } else if (companies.length === 1) {
    targetCompanyId = companies[0]._id;
    console.log(`\nNo existing admin; attaching new admin to the only company present.`);
  } else {
    console.error(`\nNo existing admin and ${companies.length} companies — can't infer a company.`);
    await disconnectDB();
    process.exit(1);
  }

  const clash = await User.findOne({ email: NEW_ADMIN.email.toLowerCase() }).lean();
  if (clash && !admins.some((a) => String(a._id) === String(clash._id))) {
    console.error(
      `\n${NEW_ADMIN.email} already exists with role "${clash.role}". ` +
        `Resolve that before running with --apply.`
    );
    await disconnectDB();
    process.exit(1);
  }

  console.log(`\nWill create:`);
  console.log(`  ${NEW_ADMIN.email}  "${NEW_ADMIN.fullName}"  role=admin  company=${targetCompanyId}`);

  if (!apply) {
    console.log(`\nDRY RUN — nothing changed. Re-run with --apply to commit.\n`);
    await disconnectDB();
    return;
  }

  // Resolved only on the --apply path, so a dry run works without the var set.
  const adminPassword = requireAdminPassword();

  if (admins.length) {
    const ids = admins.map((a) => a._id);
    await User.updateMany({ managerId: { $in: ids } }, { $set: { managerId: null } });
    const del = await User.deleteMany({ _id: { $in: ids } });
    console.log(`\nDeleted ${del.deletedCount} admin account(s).`);
  }

  const created = await User.create({
    companyId: targetCompanyId,
    fullName: NEW_ADMIN.fullName,
    email: NEW_ADMIN.email,
    passwordHash: await bcrypt.hash(adminPassword, 10),
    role: "admin",
    isActive: true,
  });

  console.log(`Created admin ${created.email}  [${created._id}]`);
  console.log(`\nLogin as ${NEW_ADMIN.email} using SEED_ADMIN_PASSWORD.\n`);
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
