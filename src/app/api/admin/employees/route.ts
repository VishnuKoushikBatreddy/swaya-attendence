/**
 * Employees CRUD (admin)
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import bcrypt from "bcryptjs";
import { User, EmployeeSiteAssignment, WorkSite } from "@/models";
import { requireRole, ok, withApi, fail } from "@/lib/api-helpers";
import { EmployeeCreateSchema } from "@/lib/validators";

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const url = new URL(req.url);
  const role = url.searchParams.get("role") || undefined;
  const filter: any = { companyId: session.user.companyId };
  if (role) filter.role = role;
  const users = await User.find(filter).sort({ fullName: 1 }).lean();
  // strip sensitive
  const safe = users.map((u: { _id: unknown; fullName: string; email: string; role: string; employeeCode?: string; department?: string; designation?: string; isActive: boolean }) => ({
    id: String(u._id),
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    employeeCode: u.employeeCode,
    department: u.department,
    designation: u.designation,
    isActive: u.isActive,
  }));
  return ok({ employees: safe });
});

export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = EmployeeCreateSchema.parse(await req.json());
  const exists = await User.findOne({ email: body.email }).lean();
  if (exists) return fail("Email already in use", 409);

  const passwordHash = await bcrypt.hash(body.password, 10);
  const user = await User.create({
    companyId: new Types.ObjectId(session.user.companyId),
    fullName: body.fullName,
    email: body.email,
    passwordHash,
    phone: body.phone,
    employeeCode: body.employeeCode,
    department: body.department,
    designation: body.designation,
    role: body.role,
    joiningDate: body.joiningDate ? new Date(body.joiningDate) : new Date(),
    isActive: true,
  });

  // Site assignments — only sites that actually belong to THIS company. Without
  // this, a forged siteId in the body would assign the new employee to another
  // company's geofence (cross-tenant reference). Invalid ids are dropped.
  if (body.siteIds && body.siteIds.length) {
    const validIds = body.siteIds.filter((s) => Types.ObjectId.isValid(s));
    const ownedSites = await WorkSite.find({
      _id: { $in: validIds.map((s) => new Types.ObjectId(s)) },
      companyId: new Types.ObjectId(session.user.companyId),
    })
      .select("_id")
      .lean();
    const ownedIds = ownedSites.map((s: { _id: unknown }) => String(s._id));
    const orderedOwned = validIds.filter((s) => ownedIds.includes(s));
    await Promise.all(
      orderedOwned.map((siteId, i) =>
        EmployeeSiteAssignment.create({
          companyId: new Types.ObjectId(session.user.companyId),
          employeeId: user._id,
          siteId: new Types.ObjectId(siteId),
          validFrom: new Date(),
          isActive: true,
          isPrimary: i === 0,
        })
      )
    );
  }

  return ok(
    {
      id: String(user._id),
      fullName: user.fullName,
      email: user.email,
      role: user.role,
    },
    { status: 201 }
  );
});