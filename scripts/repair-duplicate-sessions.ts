/**
 * Merge employees who ended up with more than one OPEN attendance session.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/repair-duplicate-sessions.ts --yes
 *
 * processCheckIn's "already checked in" guard is a read followed by a write, so
 * two check-ins arriving together both passed it. That happened in production:
 * the native geofence ENTER and the app's own auto check-in landed in the same
 * second and produced two live sessions for one employee, splitting their pings
 * across both.
 *
 * The `one_open_session_per_employee` partial unique index now prevents new
 * duplicates, but it CANNOT BE BUILT while any exist — so this runs first.
 *
 * Merge rule: keep the EARLIEST check-in (that is when the employee actually
 * arrived, so no work time is lost), move every ping and event from the losers
 * onto it, then delete the losers. Dry-run by default.
 */
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../src/lib/db";

const APPLY = process.argv.includes("--yes");

async function main() {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle on the mongoose connection.");
  console.log(`Database: ${db.databaseName}${APPLY ? "" : "   (DRY RUN — pass --yes to apply)"}\n`);

  const dupes = await db
    .collection("attendancesessions")
    .aggregate([
      { $match: { status: { $in: ["active", "flagged"] } } },
      { $group: { _id: "$employeeId", n: { $sum: 1 }, sessions: { $push: "$$ROOT" } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length === 0) {
    console.log("No employee has more than one open session.");
    await disconnectDB();
    return;
  }

  for (const group of dupes as any[]) {
    const sessions = group.sessions.sort(
      (a: any, b: any) => new Date(a.checkInAt).getTime() - new Date(b.checkInAt).getTime()
    );
    const keep = sessions[0];
    const losers = sessions.slice(1);

    console.log(`Employee ${group._id}: ${group.n} open sessions`);
    console.log(`  KEEP  ${keep._id}  checkIn=${new Date(keep.checkInAt).toISOString()} device=${keep.deviceId}`);

    for (const loser of losers) {
      const pings = await db
        .collection("locationpings")
        .countDocuments({ sessionId: loser._id });
      console.log(
        `  MERGE ${loser._id}  checkIn=${new Date(loser.checkInAt).toISOString()} device=${loser.deviceId} pings=${pings}`
      );

      if (!APPLY) continue;

      // Re-point everything that referenced the loser. The kept session has the
      // earlier check-in, so a moved ping can never predate it by more than the
      // few seconds between the two racing requests.
      for (const col of ["locationpings", "geofenceevents", "outsidesitelogs", "attendanceevents"]) {
        const r = await db
          .collection(col)
          .updateMany({ sessionId: loser._id }, { $set: { sessionId: keep._id } });
        if (r.modifiedCount) console.log(`        ${col}: moved ${r.modifiedCount}`);
      }
      await db.collection("attendancesessions").deleteOne({ _id: loser._id });
      console.log(`        deleted duplicate session`);
    }
  }

  if (APPLY) {
    const left = await db
      .collection("attendancesessions")
      .aggregate([
        { $match: { status: { $in: ["active", "flagged"] } } },
        { $group: { _id: "$employeeId", n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
      ])
      .toArray();
    console.log(`\nRemaining duplicates: ${left.length}`);
  }

  await disconnectDB();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDB();
  process.exit(1);
});
