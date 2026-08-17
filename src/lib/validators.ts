/**
 * Zod validators — shared by API routes and client forms.
 */
import { z } from "zod";

export const SignupSchema = z.object({
  companyName: z.string().min(2).max(120),
  fullName: z.string().min(2).max(120),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  timezone: z.string().default("Asia/Kolkata"),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const LoginSchema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const LocationSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().min(0).max(10_000).optional(),
  isMockLocation: z.boolean().optional(),
  batteryPercentage: z.number().min(0).max(100).optional(),
  networkType: z.enum(["wifi", "mobile_data", "offline", "unknown"]).optional(),
  appState: z.enum(["foreground", "background", "killed", "unknown"]).optional(),
  deviceId: z.string().max(200).optional(),
  appVersion: z.string().max(40).optional(),
  capturedAt: z.string().datetime().optional(),
});

export const CheckInSchema = LocationSchema.extend({
  deviceId: z.string().min(1).max(200),
  appVersion: z.string().max(40).optional(),
});

export const CheckOutSchema = LocationSchema;

export const PingBatchSchema = z.object({
  pings: z.array(CheckInSchema.partial({ capturedAt: true })).min(1).max(500),
});

export const SiteSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  radiusMeters: z.number().min(20).max(5000).default(150),
  allowedAccuracyMeters: z.number().min(5).max(500).default(50),
});

export const ShiftSchema = z.object({
  name: z.string().min(1).max(80),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  graceMinutes: z.number().min(0).max(120).default(10),
  minimumWorkMinutes: z.number().min(60).max(720).default(480),
  isNightShift: z.boolean().default(false),
});

export const EmployeeCreateSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8).max(200),
  phone: z.string().max(40).optional(),
  employeeCode: z.string().max(40).optional(),
  department: z.string().max(80).optional(),
  designation: z.string().max(80).optional(),
  role: z.enum(["admin", "employee"]).default("employee"),
  managerId: z.string().optional().nullable(),
  joiningDate: z.string().optional(),
  siteIds: z.array(z.string()).optional(),
});

export const ScheduleBulkSchema = z.object({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z.array(
    z.object({
      employeeId: z.string(),
      siteId: z.string(),
      shiftTemplateId: z.string(),
      isWorkingDay: z.boolean().default(true),
    })
  ),
});

export const ScheduleRangeSchema = z.object({
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Days that should NOT require a check-in.
  skipSundays: z.boolean().default(true),
  skipHolidays: z.boolean().default(true),
  entries: z
    .array(
      z.object({
        employeeId: z.string(),
        siteId: z.string(),
        shiftTemplateId: z.string(),
      })
    )
    .min(1),
});

export const RegularizationCreateSchema = z.object({
  attendanceDayId: z.string(),
  requestType: z.enum([
    "forgot_check_in",
    "forgot_check_out",
    "gps_issue",
    "outside_site_reason",
    "manual_correction",
  ]),
  reason: z.string().min(5).max(2000),
  requestedCheckInAt: z.string().optional(),
  requestedCheckOutAt: z.string().optional(),
});

export const LeaveCreateSchema = z.object({
  leaveType: z.enum(["casual", "sick", "paid", "unpaid", "other"]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().max(1000).optional(),
});

export const HolidaySchema = z.object({
  name: z.string().min(1).max(120),
  holidayDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const GeofenceEventSchema = z.object({
  token: z.string().min(10).max(2000),
  transition: z.enum(["ENTER", "EXIT"]),
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
  accuracy: z.number().min(0).max(10_000).optional(),
  capturedAt: z.string().datetime().optional(),
});

export const ReviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().max(2000).optional(),
});
