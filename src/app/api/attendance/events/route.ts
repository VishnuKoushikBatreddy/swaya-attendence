/**
 * Check-in / check-out event ledger (admin). Returns every check-in and
 * check-out for a date range, with how it happened — for auditing app behaviour.
 * JSON by default; `?format=csv` to download.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { AttendanceEvent, User } from "@/models";
import { requireRole, ok, withApi, fail } from "@/lib/api-helpers";
import { csvEscape } from "@/lib/csv";

export const dynamic = "force-dynamic";

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const employeeIdParam = url.searchParams.get("employeeId") || "";
  const format = url.searchParams.get("format") || "json";

  if (employeeIdParam && !Types.ObjectId.isValid(employeeIdParam)) {
    return fail("Invalid employeeId", 400);
  }

  const filter: any = { companyId: new Types.ObjectId(session.user.companyId) };
  if (from || to) {
    filter.workDate = {};
    if (from) filter.workDate.$gte = from;
    if (to) filter.workDate.$lte = to;
  }
  if (employeeIdParam) filter.employeeId = new Types.ObjectId(employeeIdParam);

  const events = await AttendanceEvent.find(filter)
    .sort({ workDate: -1, at: -1 })
    .limit(10000)
    .lean();

  const userIds = Array.from(new Set(events.map((e: any) => String(e.employeeId))));
  const users = await User.find({ _id: { $in: userIds } })
    .select("_id fullName employeeCode")
    .lean();
  const userMap = new Map(users.map((u: any) => [String(u._id), u]));

  const rows = events.map((e: any) => {
    const u = (userMap.get(String(e.employeeId)) || {}) as any;
    return {
      workDate: e.workDate,
      at: e.at,
      type: e.type,
      source: e.source,
      employeeName: u.fullName,
      employeeCode: u.employeeCode,
      lat: e.location?.coordinates?.[1] ?? null,
      lng: e.location?.coordinates?.[0] ?? null,
      accuracyMeters: e.accuracyMeters ?? null,
      distanceFromSiteMeters: e.distanceFromSiteMeters ?? null,
      sessionStatus: e.sessionStatus ?? null,
    };
  });

  if (format === "csv") {
    const header = [
      "Date", "Time (UTC)", "Type", "Source", "Employee Code", "Name",
      "Lat", "Lng", "Accuracy (m)", "Distance (m)", "Session status",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      // Every cell escaped, not just the name — employeeCode is admin-supplied
      // free text and could otherwise carry a formula or an alignment-breaking
      // comma. Numbers pass through so csvEscape's leading-"-" guard cannot turn
      // a negative latitude into text.
      lines.push([
        r.workDate,
        r.at ? new Date(r.at).toISOString() : "",
        r.type,
        r.source,
        r.employeeCode || "",
        r.employeeName || "",
        r.lat ?? "",
        r.lng ?? "",
        r.accuracyMeters ?? "",
        r.distanceFromSiteMeters ?? "",
        r.sessionStatus || "",
      ]
        .map((cell) => (typeof cell === "number" ? String(cell) : csvEscape(String(cell ?? ""))))
        .join(","));
    }
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="attendance-events-${from || "all"}.csv"`,
      },
    });
  }

  return ok({ rows });
});
