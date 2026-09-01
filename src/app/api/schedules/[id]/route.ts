/**
 * Delete a single employee schedule entry by id.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { EmployeeSchedule } from "@/models";
import { requireRole, ok, fail, withApi } from "@/lib/api-helpers";

export const DELETE = withApi(async (_req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireRole(["admin"]);
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const schedule = await EmployeeSchedule.findOneAndDelete({
    _id: ctx.params.id,
    companyId: session.user.companyId,
  });
  if (!schedule) return fail("Not found", 404);
  return ok({ id: ctx.params.id });
});
