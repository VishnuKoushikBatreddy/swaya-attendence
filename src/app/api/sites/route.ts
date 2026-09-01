import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { WorkSite } from "@/models";
import { requireAuth, requireRole } from "@/lib/api-helpers";
import { SiteSchema } from "@/lib/validators";
import { ok, withApi, parseJson, fail } from "@/lib/api-helpers";

export const GET = withApi(async (_req: NextRequest) => {
  const session = await requireAuth();
  const sites = await WorkSite.find({ companyId: session.user.companyId, isActive: true })
    .sort({ name: 1 })
    .lean();
  return ok({ sites });
});

export const POST = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const body = await parseJson(req, SiteSchema);
  const site = await WorkSite.create({
    companyId: new Types.ObjectId(session.user.companyId),
    name: body.name,
    address: body.address,
    location: {
      type: "Point",
      coordinates: [body.lng, body.lat],
    },
    radiusMeters: body.radiusMeters ?? 150,
    allowedAccuracyMeters: body.allowedAccuracyMeters ?? 50,
  });
  return ok({ site }, { status: 201 });
});