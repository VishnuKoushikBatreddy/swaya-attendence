/**
 * Clear accumulated attendance/tracking history, keeping the setup that makes
 * the app usable.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/purge-attendance-data.ts --yes
 *
 * KEPT: companies, users, worksites  (identity and site definitions)
 *       employeesiteassignments, shifttemplates, employeeschedules
 *
 * The second group is configuration, not history. Wiping it looks harmless but
 * silently disables the app: findSiteForCheckIn returns null when an employee
 * has no ACTIVE assignment, so check-in, geofencing and auto check-in all stop
 * without an error message. Auto check-in additionally requires a schedule.
 *
 * TAKE A BACKUP FIRST: scripts/backup-db.ts
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import * as Models from "../src/models";

/** Collections that survive the purge. */
const KEEP = new Set([
  "companies",
  "users",
  "worksites",
  "employeesiteassignments",
  "shifttemplates",
  "employeeschedules",
]);

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");

  // Never let this run against a database it was not pointed at deliberately.
  const expected = process.env.MONGODB_DB_NAME;
  if (expected && db.databaseName !== expected) {
    throw new Error(`Connected to "${db.databaseName}" but MONGODB_DB_NAME is "${expected}".`);
  }
  console.log(`Database: ${db.databaseName}\n`);

  const live = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const toClear = live.filter((n) => !KEEP.has(n) && !n.startsWith("system."));

  console.log("KEEP:");
  for (const n of live.filter((n) => KEEP.has(n))) {
    console.log(`   ${n.padEnd(26)} ${await db.collection(n).countDocuments()} docs`);
  }
  console.log("\nCLEAR:");
  let total = 0;
  for (const n of toClear) {
    const c = await db.collection(n).countDocuments();
    total += c;
    console.log(`   ${n.padEnd(26)} ${c} docs`);
  }

  if (!process.argv.includes("--yes")) {
    console.log(`\nDRY RUN — would delete ${total} documents. Re-run with --yes to apply.`);
    await disconnectDB();
    return;
  }

  console.log(`\nDeleting ${total} documents...`);
  for (const n of toClear) {
    // deleteMany, not drop: keeps the collection and its indexes in place, so
    // the first write afterwards does not race to rebuild them.
    const r = await db.collection(n).deleteMany({});
    console.log(`   ${n.padEnd(26)} deleted ${r.deletedCount}`);
  }

  // Site assignments survive, but they may point at an employee or site that is
  // gone; a dangling assignment sends someone to a site that no longer exists.
  const [userIds, siteIds] = await Promise.all([
    Models.User.distinct("_id"),
    Models.WorkSite.distinct("_id"),
  ]);
  const dangling = await Models.EmployeeSiteAssignment.deleteMany({
    $or: [{ employeeId: { $nin: userIds } }, { siteId: { $nin: siteIds } }],
  });
  if (dangling.deletedCount) {
    console.log(`\n   pruned ${dangling.deletedCount} dangling site assignment(s)`);
  }

  console.log("\nFinal state:");
  for (const n of live) {
    const c = await db.collection(n).countDocuments();
    console.log(`   ${KEEP.has(n) ? "KEEP " : "     "} ${n.padEnd(26)} ${c} docs`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
