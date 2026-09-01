/**
 * Audit log: read-only listing for admins.
 */
import { NextRequest } from "next/server";
import { connectDB } from "@/lib/db";

export const dynamic = "force-dynamic";
import { AuditLog } from "@/models";
import { requireRole, ok, withApi } from "@/lib/api-helpers";

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  const url = new URL(req.url);
  const limit = Math.min(500, Number(url.searchParams.get("limit") || 100));
  const logs = await AuditLog.find({ companyId: session.user.companyId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return ok({ logs });
});