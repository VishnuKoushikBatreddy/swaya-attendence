import { Schema, model, models } from "mongoose";

const AttendanceDaySchema = new Schema(
  {
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
    scheduleId: {
      type: Schema.Types.ObjectId,
      ref: "EmployeeSchedule",
      default: null,
    },
    workDate: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: [
        "pending",
        "present",
        "late",
        "half_day",
        "absent",
        "flagged",
      ],
      default: "pending",
      index: true,
    },
    firstCheckInAt: { type: Date, default: null },
    lastCheckOutAt: { type: Date, default: null },
    totalWorkSeconds: { type: Number, default: 0 },
    totalInsideSeconds: { type: Number, default: 0 },
    totalOutsideSeconds: { type: Number, default: 0 },
    outsideVisitCount: { type: Number, default: 0 },
    // Time between a check-out and the next check-in — off the clock, so kept
    // apart from totalOutsideSeconds (which is on-clock but away from the site).
    totalBreakSeconds: { type: Number, default: 0 },
    breakCount: { type: Number, default: 0 },
    // In-session time with no ping close enough to vouch for it. Reported rather
    // than silently attributed to inside/outside.
    totalOfflineSeconds: { type: Number, default: 0 },
    lateByMinutes: { type: Number, default: 0 },
    earlyLeaveMinutes: { type: Number, default: 0 },
    isFlagged: { type: Boolean, default: false, index: true },
    flagReasons: [{ type: String }],
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

AttendanceDaySchema.index({ employeeId: 1, workDate: 1 }, { unique: true });
AttendanceDaySchema.index({ companyId: 1, workDate: 1, status: 1 });

export const AttendanceDay = (models.AttendanceDay as any) || model("AttendanceDay", AttendanceDaySchema);
