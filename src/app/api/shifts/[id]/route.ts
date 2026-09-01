import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { ShiftTemplate } from "@/models";
import { requireRole, ok, withApi, fail } from "@/lib/api-helpers";
import { ShiftSchema } from "@/lib/validators";

export const PATCH = withApi(async (req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireRole(["admin"]);
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const body = ShiftSchema.partial().parse(await req.json());
  const shift = await ShiftTemplate.findOneAndUpdate(
    { _id: ctx.params.id, companyId: session.user.companyId },
    { $set: body },
    { new: true }
  );
  if (!shift) return fail("Not found", 404);
  return ok({ shift });
});

export const DELETE = withApi(async (_req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireRole(["admin"]);
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const shift = await ShiftTemplate.findOneAndUpdate(
    { _id: ctx.params.id, companyId: session.user.companyId },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!shift) return fail("Not found", 404);
  return ok({ shift });
});