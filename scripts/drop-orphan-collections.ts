/**
 * Drop collections left behind by removed features.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/drop-orphan-collections.ts
 *   ... scripts/drop-orphan-collections.ts --apply
 *
 * Mongoose creates collections but never removes them, so deleting a model
 * leaves its collection in the database indefinitely. These belonged to the
 * leave, regularization and holiday features.
 *
 * REFUSES to drop a collection that still has documents, and refuses to drop
 * anything a live model still owns — so it cannot be turned on a collection the
 * app is using, even if this list goes stale.
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import * as models from "../src/models";

const TARGETS = [
  { name: "leaverequests", reason: "LeaveRequest model removed" },
  { name: "regularizationrequests", reason: "RegularizationRequest model removed" },
  { name: "holidays", reason: "Holiday model removed" },
];

const apply = process.argv.includes("--apply");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");
  console.log(`Database: ${db.databaseName}${apply ? "" : "   (DRY RUN)"}\n`);

  // Every collection a live model still owns — never touch these.
  const owned = new Set(
    (Object.values(models) as any[])
      .filter((m) => m?.collection?.collectionName)
      .map((m) => m.collection.collectionName)
  );

  const present = new Set((await db.listCollections().toArray()).map((c) => c.name));

  let dropped = 0;
  let skipped = 0;

  for (const t of TARGETS) {
    if (!present.has(t.name)) {
      console.log(`  SKIP  ${t.name} — not present`);
      skipped++;
      continue;
    }
    if (owned.has(t.name)) {
      console.log(`  KEEP  ${t.name} — a live model still owns this collection`);
      skipped++;
      continue;
    }
    const count = await db.collection(t.name).countDocuments();
    if (count > 0) {
      // Deliberately refuse: dropping data is not this script's job.
      console.log(`  KEEP  ${t.name} — has ${count} document(s); back up and clear it first`);
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`  DROP  ${t.name} — empty, ${t.reason}`);
      dropped++;
      continue;
    }
    await db.collection(t.name).drop();
    console.log(`  DROPPED ${t.name} — ${t.reason}`);
    dropped++;
  }

  console.log(`\n${apply ? "Dropped" : "Would drop"} ${dropped}; ${skipped} skipped.`);
  if (!apply) console.log("Re-run with --apply to commit.\n");
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
