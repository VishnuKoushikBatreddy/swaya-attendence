/**
 * Export every collection in the database to a timestamped JSON folder.
 * Read-only against the database — writes only to ./backups.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backup-db.ts
 *
 * The folder name must be supplied by the caller (scripts cannot rely on a
 * stable clock here), so it is derived from an env var set by the caller.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");

  const stamp = process.env.BACKUP_STAMP || "manual";
  const dir = join(process.cwd(), "backups", `${db.databaseName}-${stamp}`);
  mkdirSync(dir, { recursive: true });

  const collections = await db.listCollections().toArray();
  let total = 0;
  const manifest: Record<string, number> = {};

  for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    const docs = await db.collection(name).find({}).toArray();
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(docs, null, 2), "utf8");
    manifest[name] = docs.length;
    total += docs.length;
    console.log(`  ${name.padEnd(26)} ${String(docs.length).padStart(6)} docs`);
  }

  writeFileSync(
    join(dir, "_manifest.json"),
    JSON.stringify({ database: db.databaseName, stamp, counts: manifest, total }, null, 2),
    "utf8"
  );

  console.log(`\nBacked up ${total} documents from ${collections.length} collections`);
  console.log(`  -> ${dir}\n`);
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
