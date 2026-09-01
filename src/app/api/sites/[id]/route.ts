import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { WorkSite } from "@/models";
import { requireAuth, requireRole, fail, ok, withApi } from "@/lib/api-helpers";
import { SiteSchema } from "@/lib/validators";
import { z } from "zod";

const PatchSchema = SiteSchema.partial();

export const GET = withApi(async (_req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireAuth();
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const site = await WorkSite.findOne({
    _id: ctx.params.id,
    companyId: session.user.companyId,
  }).lean();
  if (!site) return fail("Not found", 404);
  return ok({ site });
});

export const PATCH = withApi(async (req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireRole(["admin"]);
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const body = PatchSchema.parse(await req.json());
  const update: any = { ...body };
  if (body.lat != null && body.lng != null) {
    update.location = { type: "Point", coordinates: [body.lng, body.lat] };
    delete update.lat;
    delete update.lng;
  }
  const site = await WorkSite.findOneAndUpdate(
    { _id: ctx.params.id, companyId: session.user.companyId },
    { $set: update },
    { new: true }
  );
  if (!site) return fail("Not found", 404);
  return ok({ site });
});

export const DELETE = withApi(async (_req: NextRequest, ctx: { params: { id: string } }) => {
  const session = await requireRole(["admin"]);
  if (!Types.ObjectId.isValid(ctx.params.id)) return fail("Invalid id", 400);
  const site = await WorkSite.findOneAndUpdate(
    { _id: ctx.params.id, companyId: session.user.companyId },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!site) return fail("Not found", 404);
  return ok({ site });
});