import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { ShiftTemplate } from "@/models";
import { requireAuth, requireRole, ok, withApi } from "@/lib/api-helpers";
import { ShiftSchema } from "@/lib/validators";

export const GET = withApi(async (_req: NextRequest) => {
  const session = await requireAuth();
  const shifts = await ShiftTemplate.find({ companyId: session.user.companyId, isActive: true })
    .sort({ name: 1 })
    .lean();
  return ok({ shifts });
});

export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = ShiftSchema.parse(await req.json());
  const shift = await ShiftTemplate.create({
    companyId: new Types.ObjectId(session.user.companyId),
    ...body,
  });
  return ok({ shift }, { status: 201 });
});