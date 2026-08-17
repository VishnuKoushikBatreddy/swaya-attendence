/**
 * Drop indexes that exist in the database but are no longer declared in any
 * schema. Mongoose creates indexes from a schema but never removes them, so
 * these accumulate across schema changes and cost a write on every insert while
 * serving no read.
 *
 *   npx tsx ... scripts/drop-stale-indexes.ts           # dry run
 *   npx tsx ... scripts/drop-stale-indexes.ts --apply   # actually drop
 *
 * Only drops indexes named below, and only after re-confirming against the live
 * schema that they really are undeclared — so it can never remove an index the
 * application still depends on.
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import * as models from "../src/models";

const TARGETS: { collection: string; index: string; reason: string }[] = [
  {
    collection: "attendancesessions",
    index: "attendanceDayId_1",
    reason: "prefix of { attendanceDayId, checkInAt }",
  },
  {
    collection: "attendancesessions",
    index: "status_1",
    reason: "prefix of { status, checkInAt }",
  },
  {
    collection: "attendancesessions",
    index: "employeeId_1_status_1",
    reason: "prefix of { employeeId, status, checkInAt }",
  },
  {
    collection: "locationpings",
    index: "isInsideGeofence_1",
    reason: "boolean field, never used as a query filter",
  },
  {
    collection: "locationpings",
    index: "isMockLocation_1",
    reason: "boolean field, never used as a query filter",
  },
];

const apply = process.argv.includes("--apply");

const keySig = (key: Record<string, any>) =>
  Object.entries(key)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");
  console.log(`Database: ${db.databaseName}${apply ? "" : "   (DRY RUN)"}\n`);

  // Rebuild the set of schema-declared index signatures, per collection.
  const declaredByCollection = new Map<string, Set<string>>();
  for (const model of Object.values(models) as any[]) {
    if (!model?.collection?.collectionName || !model.schema) continue;
    const sigs = new Set<string>(
      model.schema.indexes().map(([key]: any) => keySig(key))
    );
    declaredByCollection.set(model.collection.collectionName, sigs);
  }

  let dropped = 0;
  let skipped = 0;

  for (const target of TARGETS) {
    const coll = db.collection(target.collection);
    const existing: any[] = await coll.indexes().catch(() => []);
    const found = existing.find((i) => i.name === target.index);

    if (!found) {
      console.log(`  SKIP  ${target.collection}.${target.index} — not present`);
      skipped++;
      continue;
    }

    // Safety gate: refuse to drop anything the schema still declares, even if it
    // is listed above. Protects against this script going stale after an edit.
    const declared = declaredByCollection.get(target.collection);
    if (declared?.has(keySig(found.key))) {
      console.log(
        `  KEEP  ${target.collection}.${target.index} — still declared in the schema`
      );
      skipped++;
      continue;
    }

    if (!apply) {
      console.log(`  DROP  ${target.collection}.${target.index} — ${target.reason}`);
      dropped++;
      continue;
    }

    await coll.dropIndex(target.index);
    console.log(`  DROPPED ${target.collection}.${target.index} — ${target.reason}`);
    dropped++;
  }

  console.log(
    `\n${apply ? "Dropped" : "Would drop"} ${dropped} index(es); ${skipped} skipped.`
  );
  if (!apply) console.log("Re-run with --apply to commit.\n");
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
