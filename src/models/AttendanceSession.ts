import { Schema, model, models } from "mongoose";
import { GeoPointSchema } from "./GeoPoint";

const AttendanceSessionSchema = new Schema(
  {
    // No single-field index here: the { attendanceDayId, checkInAt } compound
    // below already serves any attendanceDayId-only lookup via its prefix.
    attendanceDayId: {
      type: Schema.Types.ObjectId,
      ref: "AttendanceDay",
      required: true,
    },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    siteId: {
      type: Schema.Types.ObjectId,
      ref: "WorkSite",
      required: true,
      index: true,
    },
    checkInAt: { type: Date, required: true },
    checkInLocation: { type: GeoPointSchema, required: true },
    checkInAccuracyMeters: { type: Number },
    checkInDistanceMeters: { type: Number },
    // Snapshot of the site's geofence at check-in. Used for all geofence math on
    // this session, so editing the site (or reassigning the employee) mid-shift
    // does NOT move the geofence under someone already checked in.
    geofence: {
      type: new Schema(
        { lat: Number, lng: Number, radiusMeters: Number },
        { _id: false }
      ),
      default: null,
    },
    checkOutAt: { type: Date, default: null },
    checkOutLocation: { type: GeoPointSchema, default: null },
    checkOutAccuracyMeters: { type: Number },
    checkOutDistanceMeters: { type: Number },
    status: {
      type: String,
      enum: ["active", "completed", "auto_closed", "flagged"],
      default: "active",
      // Indexed via the { status, checkInAt } compound below, which also covers
      // the cron sweep's sort — a lone { status } index cannot.
    },
    // Set once when the offline alert fires, so the recurring sweep notifies the
    // admin a single time per session rather than on every run.
    offlineNotifiedAt: { type: Date, default: null },
    deviceId: { type: String },
    appVersion: { type: String },
  },
  { timestamps: true }
);

// Sort active-session lookups by checkInAt without an in-memory sort. Its
// { employeeId, status } prefix also serves plain employee+status filters, so no
// separate index is needed for those.
AttendanceSessionSchema.index({ employeeId: 1, status: 1, checkInAt: -1 });
// autoCloseEndedShifts sweeps open sessions across ALL employees:
//   find({ status: { $in: ["active","flagged"] } }).sort({ checkInAt: 1 })
// A status-only index answers the filter but forces an in-memory sort, which
// fails outright past MongoDB's 32MB sort limit. This compound serves both.
AttendanceSessionSchema.index({ status: 1, checkInAt: 1 });
// recomputeDayTotals / today: all sessions of a day in check-in order.
AttendanceSessionSchema.index({ attendanceDayId: 1, checkInAt: 1 });
AttendanceSessionSchema.index({ checkInLocation: "2dsphere" });

export const AttendanceSession =
  (models.AttendanceSession as any) || model("AttendanceSession", AttendanceSessionSchema);
