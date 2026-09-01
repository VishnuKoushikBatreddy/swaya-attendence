/**
 * Live employee status for admins.
 *
 * "Is this person checked in RIGHT NOW" lives on AttendanceSession.status
 * (active | flagged), not on AttendanceDay.status — which only classifies the
 * day as present/late/half_day and stays set long after someone checks out.
 * No admin-facing endpoint exposed session state before this one, which is why
 * the admin UI could only ever show day-level aggregates.
 *
 * Deliberately a fixed number of queries (5) no matter how many employees the
 * company has — the obvious implementation is one lookup per person.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import {
  AttendanceDay,
  AttendanceSession,
  LocationPing,
  User,
  WorkSite,
} from "@/models";
import { requireRole, ok, withApi } from "@/lib/api-helpers";
import { getCompanyTimezone } from "@/lib/company";
import { todayWorkDate } from "@/lib/workdate";
import { haversineDistanceMeters } from "@/lib/geo";
import { deriveConnectivity } from "@/lib/attendance-logic";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export const GET = withApi(async (_req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const companyId = new Types.ObjectId(session.user.companyId);

  const userFilter: Record<string, unknown> = { companyId, isActive: true };

  const [timezone, users, openSessions] = await Promise.all([
    getCompanyTimezone(session.user.companyId),
    User.find(userFilter)
      .select("_id fullName email employeeCode department role")
      .sort({ fullName: 1 })
      .lean(),
    AttendanceSession.find({ companyId, status: { $in: ["active", "flagged"] } })
      .select("_id employeeId siteId checkInAt status geofence")
      .lean(),
  ]);

  const workDate = todayWorkDate(timezone);
  // Models are loosely typed (see src/models/index.ts), so annotate locally.
  const sessionByEmployee = new Map<string, any>(
    openSessions.map((s: any) => [String(s.employeeId), s])
  );

  // Today's day rollups, plus the newest ping of each open session. Both are
  // single batched queries rather than one per employee.
  const [days, latestPings, sites] = await Promise.all([
    AttendanceDay.find({ companyId, workDate })
      .select("employeeId status totalWorkSeconds isFlagged firstCheckInAt lastCheckOutAt")
      .lean(),
    openSessions.length
      ? LocationPing.aggregate([
          { $match: { sessionId: { $in: openSessions.map((s: any) => s._id) } } },
          { $sort: { capturedAt: -1 } },
          {
            $group: {
              _id: "$sessionId",
              capturedAt: { $first: "$capturedAt" },
              location: { $first: "$location" },
              isInsideGeofence: { $first: "$isInsideGeofence" },
              accuracyMeters: { $first: "$accuracyMeters" },
              batteryPercentage: { $first: "$batteryPercentage" },
            },
          },
        ])
      : Promise.resolve([]),
    openSessions.length
      ? WorkSite.find({ _id: { $in: openSessions.map((s: any) => s.siteId) } })
          .select("_id name location radiusMeters")
          .lean()
      : Promise.resolve([]),
  ]);

  const dayByEmployee = new Map<string, any>(days.map((d: any) => [String(d.employeeId), d]));
  const pingBySession = new Map<string, any>(latestPings.map((p: any) => [String(p._id), p]));
  const siteById = new Map<string, any>(sites.map((s: any) => [String(s._id), s]));

  const nowMs = Date.now();

  const rows = users.map((u: any) => {
    const open = sessionByEmployee.get(String(u._id));
    const day = dayByEmployee.get(String(u._id));
    const ping = open ? pingBySession.get(String(open._id)) : null;
    const site = open ? siteById.get(String(open.siteId)) : null;

    // Distance from the session's frozen geofence centre, falling back to the
    // live site for sessions created before snapshots existed.
    let distanceFromSiteMeters: number | null = null;
    if (ping?.location?.coordinates) {
      const centre =
        open?.geofence?.lat != null
          ? { lat: open.geofence.lat, lng: open.geofence.lng }
          : site?.location?.coordinates
            ? { lat: site.location.coordinates[1], lng: site.location.coordinates[0] }
            : null;
      if (centre) {
        distanceFromSiteMeters = Math.round(
          haversineDistanceMeters(centre, {
            lat: ping.location.coordinates[1],
            lng: ping.location.coordinates[0],
          })
        );
      }
    }

    return {
      id: String(u._id),
      fullName: u.fullName,
      email: u.email,
      employeeCode: u.employeeCode ?? null,
      department: u.department ?? null,
      role: u.role,

      checkedIn: !!open,
      // Lets the client tick a live duration without re-fetching.
      checkedInAt: open ? open.checkInAt : null,
      sessionStatus: open ? open.status : null,
      siteName: site?.name ?? null,

      // "Checked in" only means a session is open. Connectivity says whether the
      // phone is still reporting — without it a dead phone and someone actively
      // working look identical on the board.
      connectivity: open
        ? deriveConnectivity(
            ping?.capturedAt ? new Date(ping.capturedAt).getTime() : null,
            nowMs,
            env.PING_INTERVAL_MS,
            env.OFFLINE_AFTER_MS
          )
        : null,
      lastSeenAt: ping?.capturedAt ?? null,
      lastSeenMinutesAgo: ping?.capturedAt
        ? Math.max(0, Math.floor((nowMs - new Date(ping.capturedAt).getTime()) / 60_000))
        : null,
      isInsideGeofence: ping ? !!ping.isInsideGeofence : null,
      distanceFromSiteMeters,
      batteryPercentage: ping?.batteryPercentage ?? null,

      dayStatus: day?.status ?? null,
      totalWorkSeconds: day?.totalWorkSeconds ?? 0,
      isFlagged: !!day?.isFlagged,
      firstCheckInAt: day?.firstCheckInAt ?? null,
      lastCheckOutAt: day?.lastCheckOutAt ?? null,
    };
  });

  return ok({
    workDate,
    timezone,
    // Lets the client label thresholds without duplicating the rule.
    pingIntervalMs: env.PING_INTERVAL_MS,
    offlineAfterMs: env.OFFLINE_AFTER_MS,
    serverTime: new Date().toISOString(),
    summary: {
      total: rows.length,
      checkedIn: rows.filter((r: any) => r.checkedIn).length,
      outsideGeofence: rows.filter((r: any) => r.checkedIn && r.isInsideGeofence === false).length,
      offline: rows.filter((r: any) => r.connectivity === "offline").length,
      flagged: rows.filter((r: any) => r.isFlagged).length,
    },
    employees: rows,
  });
});
