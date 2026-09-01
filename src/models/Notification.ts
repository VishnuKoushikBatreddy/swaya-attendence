import { Schema, model, models } from "mongoose";

/**
 * In-app admin notifications.
 *
 * Replaces the SMTP alerts: these are written to the database and read from the
 * admin dashboard, so nothing depends on mail delivery being configured.
 *
 * Addressed to a COMPANY rather than a specific admin. Every admin of that
 * company sees the same feed, and `readBy` records who has dismissed it — a
 * single `isRead` boolean would let one admin mark an alert read and hide it
 * from the rest.
 */
const NotificationSchema = new Schema(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["site_exit", "offline", "check_out", "check_in"],
      required: true,
      index: true,
    },
    /** Severity drives the colour/emphasis in the UI. */
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
    },
    title: { type: String, required: true },
    body: { type: String, required: true },

    // Who/what the notification is about. Kept denormalised so the feed renders
    // from one query — an employee later renamed or deleted must not blank out
    // the history of alerts about them.
    employeeId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    employeeName: { type: String, default: "" },
    employeeCode: { type: String, default: "" },
    employeePhone: { type: String, default: "" },
    siteId: { type: Schema.Types.ObjectId, ref: "WorkSite", default: null },
    siteName: { type: String, default: "" },
    sessionId: { type: Schema.Types.ObjectId, ref: "AttendanceSession", default: null },

    /** Type-specific extras (distance, minutes silent, checkout reason, ...). */
    meta: { type: Schema.Types.Mixed, default: {} },

    /** When the underlying event happened — not when the row was written. */
    occurredAt: { type: Date, required: true, index: true },

    /** Admin user ids that have marked this read. */
    readBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

// The feed query: newest-first within a company.
NotificationSchema.index({ companyId: 1, occurredAt: -1 });

/**
 * De-duplication key, e.g. "offline:<sessionId>". Unique when present, so a
 * repeated sweep or a retried request cannot post the same alert twice. Sparse +
 * partial so rows without a key are unconstrained.
 */
NotificationSchema.index(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);
NotificationSchema.add({ dedupeKey: { type: String, default: undefined } });

export const Notification =
  (models.Notification as any) || model("Notification", NotificationSchema);
