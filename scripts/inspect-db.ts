/**
 * READ-ONLY database audit.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/inspect-db.ts
 *
 * Reports, for the configured database:
 *   1. every collection, its document count and storage size
 *   2. collections with no backing Mongoose model (candidate cruft)
 *   3. models whose collection does not exist yet
 *   4. per-collection index drift: declared in schema but missing in the DB,
 *      and present in the DB but no longer declared
 *
 * Nothing is created, modified or dropped by this script.
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import * as models from "../src/models";

type IndexInfo = { name: string; key: Record<string, any>; unique?: boolean };

const keySig = (key: Record<string, any>) =>
  Object.entries(key)
    .map(([k, v]) => `${k}:${v}`)
    .join(",");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");
  console.log(`Database: ${db.databaseName}\n`);

  // Every Mongoose model that is a real model (skip sub-schema exports).
  const modelEntries = Object.entries(models).filter(
    ([, m]: [string, any]) => m && typeof m === "function" && m.collection?.collectionName
  ) as [string, any][];
  const modelByCollection = new Map(
    modelEntries.map(([name, m]) => [m.collection.collectionName, { name, model: m }])
  );

  const collections = await db.listCollections().toArray();
  const names = collections.map((c) => c.name).sort();

  console.log("── Collections in the database ──────────────────────────────");
  const orphans: string[] = [];
  for (const name of names) {
    const count = await db.collection(name).countDocuments();
    let sizeKb = 0;
    try {
      const stats: any = await db.command({ collStats: name });
      sizeKb = Math.round((stats.storageSize ?? 0) / 1024);
    } catch {
      /* collStats unavailable on some tiers */
    }
    const owner = modelByCollection.get(name);
    const tag = owner ? `model ${owner.name}` : "NO MODEL";
    if (!owner) orphans.push(name);
    console.log(
      `  ${name.padEnd(26)} ${String(count).padStart(8)} docs  ${String(sizeKb).padStart(7)} KB   ${tag}`
    );
  }

  console.log("\n── Collections with no backing model ────────────────────────");
  console.log(orphans.length ? orphans.map((o) => "  " + o).join("\n") : "  (none)");

  console.log("\n── Models with no collection yet ────────────────────────────");
  const missing = modelEntries
    .map(([n, m]) => [n, m.collection.collectionName] as const)
    .filter(([, c]) => !names.includes(c));
  console.log(
    missing.length
      ? missing.map(([n, c]) => `  ${n} -> ${c} (created lazily on first write)`).join("\n")
      : "  (none)"
  );

  console.log("\n── Index drift (schema vs database) ─────────────────────────");
  let drift = 0;
  for (const [modelName, model] of modelEntries) {
    const coll = model.collection.collectionName;
    if (!names.includes(coll)) continue;

    // What the schema declares: explicit .index() calls + field-level index:true.
    const declared: IndexInfo[] = model.schema.indexes().map(([key, opts]: any) => ({
      name: "(schema)",
      key,
      unique: !!opts?.unique,
    }));
    const declaredSigs = new Set(declared.map((d) => keySig(d.key)));

    const actual: IndexInfo[] = (await db.collection(coll).indexes()) as any;
    const actualSigs = new Set(
      actual.filter((i) => i.name !== "_id_").map((i) => keySig(i.key))
    );

    const missingIdx = [...declaredSigs].filter((s) => !actualSigs.has(s));
    const extraIdx = actual
      .filter((i) => i.name !== "_id_" && !declaredSigs.has(keySig(i.key)))
      .map((i) => `${i.name} {${keySig(i.key)}}`);

    if (missingIdx.length || extraIdx.length) {
      drift++;
      console.log(`\n  ${modelName} (${coll})`);
      for (const m of missingIdx) console.log(`    MISSING in DB : {${m}}`);
      for (const e of extraIdx) console.log(`    EXTRA in DB   : ${e}`);
    }
  }
  if (!drift) console.log("  (no drift — every collection matches its schema)");

  console.log("\n");
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
