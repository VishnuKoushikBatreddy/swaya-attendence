/**
 * READ-ONLY: what is actually stored in the attendance-activity collections, and
 * what else in the database points at those records.
 *
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/inspect-attendance-data.ts
 */
import {
  AttendanceDay,
  AttendanceEvent,
  AttendanceSession,
  GeofenceEvent,
  LocationPing,
  OutsideSiteLog,
  User,
} from "../src/models";
import { connectDB, disconnectDB } from "../src/lib/db";

async function main() {
  await connectDB();

  const [pings, events, sessions, geofences, days, outside] = await Promise.all([
    LocationPing.countDocuments(),
    AttendanceEvent.countDocuments(),
    AttendanceSession.countDocuments(),
    GeofenceEvent.countDocuments(),
    AttendanceDay.countDocuments(),
    OutsideSiteLog.countDocuments(),
  ]);

  console.log("── Collections the user asked about ─────────────────────────");
  console.log(`  locationpings          ${String(pings).padStart(6)}`);
  console.log(`  attendanceevents       ${String(events).padStart(6)}`);
  console.log(`  attendancesessions     ${String(sessions).padStart(6)}`);
  console.log(`  geofenceevents         ${String(geofences).padStart(6)}`);

  console.log("\n── Related records that would be left behind ────────────────");
  console.log(`  attendancedays         ${String(days).padStart(6)}  (day rollups: totals, status, flags)`);
  console.log(`  outsidesitelogs        ${String(outside).padStart(6)}  (each references a sessionId)`);

  // An OPEN session means somebody is checked in right now.
  const open: any[] = await AttendanceSession.find({
    status: { $in: ["active", "flagged"] },
  }).lean();
  console.log("\n── Open sessions (someone is currently checked in) ──────────");
  if (!open.length) {
    console.log("  (none — nobody is checked in)");
  } else {
    for (const s of open) {
      const u: any = await User.findById(s.employeeId).select("fullName email").lean();
      console.log(
        `  ${u?.email ?? s.employeeId}  checked in ${new Date(s.checkInAt).toISOString()}  status=${s.status}`
      );
    }
  }

  // Session status split + date span, so the user can see what history exists.
  const byStatus = await AttendanceSession.aggregate([
    { $group: { _id: "$status", n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log("\n── Sessions by status ───────────────────────────────────────");
  for (const s of byStatus) console.log(`  ${String(s._id).padEnd(14)} ${s.n}`);

  const dayDocs: any[] = await AttendanceDay.find().select("workDate status totalWorkSeconds").sort({ workDate: 1 }).lean();
  console.log("\n── Attendance days on record ────────────────────────────────");
  for (const d of dayDocs) {
    console.log(
      `  ${d.workDate}  status=${String(d.status).padEnd(9)} work=${d.totalWorkSeconds ?? 0}s`
    );
  }

  console.log("\n── Referential impact of deleting sessions ──────────────────");
  const sessionIds = (await AttendanceSession.find().select("_id").lean()).map((s: any) => s._id);
  const orphanedOutside = await OutsideSiteLog.countDocuments({ sessionId: { $in: sessionIds } });
  const orphanedPings = await LocationPing.countDocuments({ sessionId: { $in: sessionIds } });
  console.log(`  outsidesitelogs pointing at a session : ${orphanedOutside}`);
  console.log(`  locationpings   pointing at a session : ${orphanedPings}`);

  console.log("\n");
  await disconnectDB();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
