import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { EmployeeSiteAssignment, User, WorkSite } from "@/models";
import { requireAuth, requireRole, ok, withApi, fail } from "@/lib/api-helpers";
import { z } from "zod";

const Schema = z.object({
  employeeId: z.string(),
  siteIds: z.array(z.string()),
});

/**
 * List site assignments.
 *
 * Employees see ONLY their own. This used to return every assignment in the
 * company to any signed-in user, which leaked who works where — and quietly
 * broke the employee's own "My work sites" page, since that builds its list from
 * whatever this returns and was therefore showing colleagues' sites too.
 */
export const GET = withApi(async (req: NextRequest) => {
  const session = await requireAuth();
  const url = new URL(req.url);
  const requested = url.searchParams.get("employeeId");

  const filter: any = { companyId: session.user.companyId, isActive: true };

  if (session.user.role === "employee") {
    // Not "reject a mismatched id" — just pin it. An employee asking for someone
    // else gets their own assignments rather than an error.
    filter.employeeId = new Types.ObjectId(session.user.id);
  } else if (requested) {
    if (!Types.ObjectId.isValid(requested)) return fail("Invalid employeeId", 400);
    filter.employeeId = new Types.ObjectId(requested);
  }

  const assignments = await EmployeeSiteAssignment.find(filter).lean();
  return ok({ assignments });
});

/**
 * Replace an employee's site assignments.
 *
 * Every id is confirmed to belong to the caller's company first. Without that,
 * an admin could assign their employee to another tenant's site, or attach an
 * assignment to a user outside their company — the same cross-tenant hole
 * /api/schedules already guards against.
 */
export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = Schema.parse(await req.json());
  const companyId = new Types.ObjectId(session.user.companyId);

  if (!Types.ObjectId.isValid(body.employeeId)) {
    return fail("Invalid employeeId", 400);
  }
  const invalidSite = body.siteIds.find((id) => !Types.ObjectId.isValid(id));
  if (invalidSite) return fail("Invalid siteId", 400);

  const employeeId = new Types.ObjectId(body.employeeId);
  const siteIds = body.siteIds.map((id) => new Types.ObjectId(id));

  // Ownership checks, both scoped to the caller's company.
  const [employee, sites] = await Promise.all([
    User.findOne({ _id: employeeId, companyId }).select("_id").lean(),
    WorkSite.find({ _id: { $in: siteIds }, companyId }).select("_id").lean(),
  ]);

  if (!employee) return fail("Employee not found", 404);
  if (sites.length !== siteIds.length) {
    // Report which ones, so a genuine typo is obvious and a probe is logged.
    const owned = new Set(sites.map((s: any) => String(s._id)));
    const foreign = body.siteIds.filter((id) => !owned.has(id));
    return fail(`Unknown site(s): ${foreign.join(", ")}`, 400);
  }

  // Soft-deactivate existing
  await EmployeeSiteAssignment.updateMany(
    { companyId, employeeId, isActive: true },
    { $set: { isActive: false, validTo: new Date() } }
  );

  const created = await Promise.all(
    siteIds.map((siteId, i) =>
      EmployeeSiteAssignment.create({
        companyId,
        employeeId,
        siteId,
        validFrom: new Date(),
        isActive: true,
        isPrimary: i === 0,
      })
    )
  );
  return ok({ assignments: created }, { status: 201 });
});
