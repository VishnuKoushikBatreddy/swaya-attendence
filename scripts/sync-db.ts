/**
 * Bring the live database in line with the current models.
 *
 * Every step is idempotent — running this twice changes nothing the second
 * time — so it is safe to re-run after a deploy.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/sync-db.ts
 *
 * Add --drop-orphans to also drop collections that no model maps to. That is
 * destructive and off by default; the dry report always lists them first.
 *
 * TAKE A BACKUP FIRST: scripts/backup-db.ts
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";
import * as Models from "../src/models";
import {
  computeDayTotals,
  classifyOutsideForDay,
  classifyOfflineForDay,
  deriveIsFlagged,
  resolveDayStatus,
} from "../src/lib/attendance-logic";
import { env } from "../src/lib/env";

const DROP_ORPHANS = process.argv.includes("--drop-orphans");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");
  console.log(`Database: ${db.databaseName}\n`);

  const modelList = Object.values(Models as Record<string, any>);
  const modelled = new Set(modelList.map((m) => m.collection.collectionName));

  // -- 1. Backfill fields added since these documents were written -----------
  // A missing number field is not the same as 0: it breaks $inc, sorts oddly,
  // and reads as undefined in arithmetic. New numeric totals get an explicit 0.
  console.log("1. Backfilling new numeric fields on attendancedays");
  for (const field of ["totalOfflineSeconds", "totalBreakSeconds", "breakCount"]) {
    const r = await db
      .collection("attendancedays")
      .updateMany({ [field]: { $exists: false } }, { $set: { [field]: 0 } });
    console.log(`   ${field.padEnd(22)} set on ${r.modifiedCount} docs`);
  }

  // -- 2. Drop fields whose feature was removed ------------------------------
  // managerId is left over from the manager role. It appears nowhere in src/,
  // so it is dead weight that still shows up in every query result.
  console.log("\n2. Dropping removed-feature fields");
  const mgr = await db
    .collection("users")
    .updateMany({ managerId: { $exists: true } }, { $unset: { managerId: "" } });
  console.log(`   users.managerId          removed from ${mgr.modifiedCount} docs`);

  // -- 3. Repair employees with no site assignment ---------------------------
  // resolveSiteForEmployee returns null when an employee has no ACTIVE
  // assignment, and a null site means check-in, geofencing and auto check-in
  // all silently do nothing. An employee who has schedules but no assignment is
  // therefore broken, not merely untidy — the schedule names the site they are
  // expected at, so it is the correct source to repair from.
  console.log("\n3. Repairing missing site assignments");
  const employees = await db
    .collection("users")
    .find({ role: "employee", isActive: true })
    .toArray();
  let repaired = 0;
  for (const emp of employees) {
    const active = await db
      .collection("employeesiteassignments")
      .countDocuments({ employeeId: emp._id, isActive: true });
    if (active > 0) continue;

    const schedule = await db
      .collection("employeeschedules")
      .find({ employeeId: emp._id, siteId: { $ne: null } })
      .sort({ workDate: -1 })
      .limit(1)
      .toArray();
    const siteId = schedule[0]?.siteId;
    if (!siteId) {
      console.log(`   ${emp.email}: no schedule to infer a site from — SKIPPED`);
      continue;
    }
    await db.collection("employeesiteassignments").updateOne(
      { employeeId: emp._id, siteId },
      {
        $set: { isActive: true, isPrimary: true, companyId: emp.companyId },
        $setOnInsert: { createdAt: new Date(), updatedAt: new Date() },
      },
      { upsert: true }
    );
    console.log(`   ${emp.email}: assigned to site ${siteId}`);
    repaired++;
  }
  if (repaired === 0) console.log("   (all active employees already assigned)");

  // -- 4. Recompute day totals with the current logic ------------------------
  // Rows written before the time-accounting fixes do not reconcile: one has
  // 4h03m "outside" on a 2h40m day, because outside used to accumulate from
  // between-session gaps and stale pings were extrapolated across long silences.
  // Those totals are what reports and payroll read, so they are recomputed from
  // the underlying sessions and pings rather than left to contradict themselves.
  console.log("\n4. Recomputing day totals with current logic");
  const days = await Models.AttendanceDay.find({}).lean();
  for (const day of days as any[]) {
    const [sessions, pings] = await Promise.all([
      Models.AttendanceSession.find({ attendanceDayId: day._id }).sort({ checkInAt: 1 }).lean(),
      Models.LocationPing.find({ attendanceDayId: day._id })
        .select("sessionId capturedAt isInsideGeofence")
        .sort({ capturedAt: 1 })
        .lean(),
    ]);
    const bySession = new Map<string, any[]>();
    for (const p of pings as any[]) {
      const k = String(p.sessionId);
      const arr = bySession.get(k);
      if (arr) arr.push(p);
      else bySession.set(k, [p]);
    }

    const totals = computeDayTotals(sessions as any[], bySession, Date.now(), {
      maxIntervalMs: env.PING_TRUST_WINDOW_MS,
    });
    const outside = classifyOutsideForDay({ totalOutsideSeconds: totals.totalOutsideSeconds });
    const offline = classifyOfflineForDay({
      totalOfflineSeconds: totals.totalOfflineSeconds,
      totalWorkSeconds: totals.totalWorkSeconds,
    });

    // Rebuild the flag set from scratch: a reason that no longer holds under the
    // current rules must not survive the migration.
    const reasons = new Set<string>(
      (day.flagReasons || []).filter(
        (r: string) => r !== "excessive_outside_time" && r !== "excessive_offline_time"
      )
    );
    if (outside.flagExcessiveOutside) reasons.add("excessive_outside_time");
    if (offline.flagExcessiveOffline) reasons.add("excessive_offline_time");

    const status = resolveDayStatus({
      currentStatus: day.status,
      totalWorkSeconds: totals.totalWorkSeconds,
      lateByMinutes: day.lateByMinutes || 0,
    });

    await Models.AttendanceDay.updateOne(
      { _id: day._id },
      {
        $set: {
          ...totals,
          status,
          // Derived from the REAL flags only — benign audit markers share this
          // array and must not keep a day flagged. See deriveIsFlagged.
          isFlagged: deriveIsFlagged(reasons),
          flagReasons: Array.from(reasons),
        },
      }
    );

    const h = (s: number) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
    const before = `work=${h(day.totalWorkSeconds || 0)} in=${h(day.totalInsideSeconds || 0)} out=${h(day.totalOutsideSeconds || 0)}`;
    const after = `work=${h(totals.totalWorkSeconds)} in=${h(totals.totalInsideSeconds)} out=${h(totals.totalOutsideSeconds)} off=${h(totals.totalOfflineSeconds)}`;
    console.log(`   ${day.workDate}  ${before}\n              -> ${after}  ${status}${reasons.size ? ` [${Array.from(reasons).join(",")}]` : ""}`);
  }
  if (days.length === 0) console.log("   (no attendance days)");

  // -- 5. Reconcile indexes with the schemas ---------------------------------
  // syncIndexes builds anything missing and drops anything the schema no longer
  // declares, which is what clears the stale managerId index.
  console.log("\n5. Syncing indexes");
  for (const model of modelList) {
    const dropped: string[] = await model.syncIndexes();
    const label = model.collection.collectionName.padEnd(24);
    console.log(`   ${label} ${dropped.length ? `dropped ${dropped.join(", ")}` : "ok"}`);
  }

  // -- 6. Collections no model maps to ---------------------------------------
  console.log("\n6. Orphaned collections");
  const live = (await db.listCollections().toArray()).map((c) => c.name);
  const orphans = live.filter((n) => !modelled.has(n) && !n.startsWith("system."));
  if (orphans.length === 0) {
    console.log("   (none — every collection maps to a model)");
  } else {
    for (const name of orphans) {
      const n = await db.collection(name).countDocuments();
      if (DROP_ORPHANS) {
        await db.collection(name).drop();
        console.log(`   DROPPED ${name} (${n} docs)`);
      } else {
        console.log(`   ORPHAN  ${name} (${n} docs) — re-run with --drop-orphans to remove`);
      }
    }
  }

  // -- 7. Final state --------------------------------------------------------
  console.log("\nFinal collections:");
  for (const name of (await db.listCollections().toArray()).map((c) => c.name).sort()) {
    console.log(`   ${name.padEnd(26)} ${await db.collection(name).countDocuments()} docs`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
