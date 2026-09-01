/**
 * Admin notification feed.
 *
 * GET   — list notifications for the caller's company, newest first, with an
 *         unread count for the nav badge.
 * PATCH — mark one, several, or all as read for the calling admin.
 *
 * Read state is per-admin (`readBy` holds user ids) so one admin clearing the
 * feed does not hide alerts from their colleagues.
 */
import { NextRequest } from "next/server";
import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Notification } from "@/models";
import { requireRole, ok, fail, withApi } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const TYPES = ["site_exit", "offline", "check_out", "check_in"] as const;

export const GET = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  await connectDB();

  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
  const type = url.searchParams.get("type") || "";
  const unreadOnly = url.searchParams.get("unread") === "1";

  const companyId = new Types.ObjectId(String(session.user.companyId));
  const userId = new Types.ObjectId(String(session.user.id));

  const filter: any = { companyId };
  if (type && (TYPES as readonly string[]).includes(type)) filter.type = type;
  if (unreadOnly) filter.readBy = { $ne: userId };

  const [rows, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ occurredAt: -1 }).limit(limit).lean(),
    Notification.countDocuments({ companyId, readBy: { $ne: userId } }),
  ]);

  // `readBy` is an implementation detail and grows with the admin count; send a
  // single boolean for the caller instead of the whole array.
  const notifications = rows.map((n: any) => {
    const { readBy, ...rest } = n;
    return {
      ...rest,
      isRead: (readBy || []).some((id: any) => String(id) === String(userId)),
    };
  });

  return ok({ notifications, unreadCount });
});

export const PATCH = withApi(async (req: NextRequest) => {
  const session = await requireRole(["admin"]);
  await connectDB();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("Invalid JSON body", 400);
  }

  const companyId = new Types.ObjectId(String(session.user.companyId));
  const userId = new Types.ObjectId(String(session.user.id));

  // Mark everything read.
  if (body?.all === true) {
    const r = await Notification.updateMany(
      { companyId, readBy: { $ne: userId } },
      { $addToSet: { readBy: userId } }
    );
    return ok({ updated: r.modifiedCount ?? 0 });
  }

  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids
    : body?.id
      ? [body.id]
      : [];
  if (ids.length === 0) return fail("Provide `id`, `ids`, or `all: true`", 400);
  if (ids.some((id) => !Types.ObjectId.isValid(id))) {
    return fail("Invalid notification id", 400);
  }

  // Scoped by companyId as well as _id: an id from another company must not be
  // mutable just because it was guessed.
  const r = await Notification.updateMany(
    { _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, companyId },
    { $addToSet: { readBy: userId } }
  );
  return ok({ updated: r.modifiedCount ?? 0 });
});
