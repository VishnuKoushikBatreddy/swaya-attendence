# Swaya Attendance — Functionality & Flow Reference

> A complete walkthrough of how every part of the app works, written so you can
> review each flow and note where you'd like improvements. Each section ends with
> the relevant source files. A consolidated **"Gaps & improvement opportunities"**
> list is at the end (§19) — that's the best place to hang your suggestions.

_Last updated for the codebase as of the auto-checkout / responsive / CRUD work._

---

## 1. What the app is

A **geo-fenced attendance system**. Employees check in/out from a phone; the app
verifies they're physically inside a work site's GPS radius, tracks their location
in the background while on shift, and produces attendance records and reports.

**Architecture at a glance:**

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  Android app (Capacitor)│  loads  │  Next.js web app on Vercel    │
│  thin WebView shell      │ ──────► │  https://…vercel.app          │
│  + background GPS plugin │         │  (UI + API routes + MongoDB)  │
└─────────────────────────┘         └──────────────────────────────┘
```

- The **web app is the product.** The Android app is a thin shell that loads the
  live Vercel URL (`capacitor.config.ts`). So a web deploy = an app update; no
  APK rebuild is needed for UI/logic changes.
- **Stack:** Next.js 14 (App Router), MongoDB + Mongoose, NextAuth (JWT sessions),
  Tailwind + shadcn/ui, Leaflet maps, Capacitor (Android), background-geolocation
  plugin.

---

## 2. Roles & access control

Two roles. An admin can also reach the employee area, so they can see exactly
what staff see.

| Role | Can access | Main features |
|------|-----------|---------------|
| **admin** | Admin + employee areas | Sites, employees, shifts, schedules, live status, reports, audit |
| **employee** | Employee area only | Check in/out, history, my sites |

- **Enforced in two places:** `src/middleware.ts` (route guards by URL prefix) and
  every API route via `requireRole([...])` in `src/lib/api-helpers.ts`.
- Unauthorized access redirects the user back to their own role's home.
- Multi-tenant: every record carries a `companyId`; users only ever see their own
  company's data.

_Files: `src/middleware.ts`, `src/lib/api-helpers.ts`, `src/app/page.tsx`_

---

## 3. Authentication & onboarding

### Signup (creates a company)
Signing up is **company creation**, not employee self-registration:
1. Form collects company name, your name, email, password, timezone.
2. API creates a **Company** and a **first User with role `admin`**, password
   hashed with bcrypt.
3. Email must be unique (409 if taken).

So every company starts with one admin who then creates the rest of the team.

### Login
- Credentials provider (email + password), bcrypt comparison.
- **Inactive users are blocked**: `if (!user || !user.isActive) return null`.
- Session is a **JWT (7-day expiry)** carrying `id`, `role`, `companyId`, `email`,
  `name` — so role checks need no extra DB lookup.

### Password reset
- "Forgot password" generates a random token, stores a **SHA-256 hash** of it with
  a **1-hour expiry**, and emails a reset link.
- Email is sent via SMTP **if configured**, otherwise the link is **printed to the
  server console** (dev fallback).
- Responses are deliberately vague ("if the email exists…") to avoid leaking which
  emails are registered.

### Routing by role
- Root `/` and login redirect each user to their dashboard
  (admin → `/admin`, employee → `/employee`).

_Files: `src/app/api/auth/*`, `src/lib/auth.ts`, `src/lib/email.ts`, `src/middleware.ts`_

---

## 4. Core data model

Key entities and how they relate:

```
Company
 ├── User (admin | employee)
 ├── WorkSite (GPS point + radius)
 ├── ShiftTemplate (start/end/grace/min-work/night)
 ├── EmployeeSiteAssignment (User ↔ WorkSite, PERMANENT)   ← used by check-in
 ├── EmployeeSchedule (User + date → site + shift, PER-DAY) ← used for late/grace only
 │
 ├── AttendanceDay (one per employee per work-date)      ← the daily summary record
 │    └── AttendanceSession (one per check-in/out cycle)
 │         ├── LocationPing (GPS samples every ~60s)
 │         ├── GeofenceEvent (entered_site / exited_site)
 │         └── OutsideSiteLog (a span spent outside the radius)
 │
 ├── EmployeeDevice (registered device ids)
 └── AuditLog (who-did-what — see §18, currently not written to)
```

_Files: `src/models/*`_

---

## 5. Work sites & geofencing

- A site = a **GPS point** (lat/lng) + a **radius in meters** + an accuracy
  tolerance. Admins create/edit them on a map (`/admin/sites`).
- **Inside check:** `distance(point, center) <= radius + gpsAccuracy`
  (`isInsideGeofence` in `src/lib/geo.ts`, Haversine distance).
- The accuracy tolerance prevents false "outside" readings from GPS jitter.

_Files: `src/app/(dashboard)/admin/sites/page.tsx`, `src/lib/geo.ts`, `src/models/WorkSite.ts`_

---

## 6. Employees management (`/admin/employees`)

Full admin CRUD:
- **Create:** name, email, password, phone, code, department, designation, role,
  and initial **site assignments**.
- **Edit:** profile fields + role (email/password/site-assignment are *not* edited
  here — email shows disabled).
- **Active/Inactive toggle:** click the status badge to flip `isActive`. Inactive =
  account cannot log in, but the record and history are kept.
- **Delete (hard, cascade):** the trash icon **permanently deletes** the employee
  AND all their data — assignments, schedules, attendance days/sessions, pings,
  geofence events, outside-site logs, devices.
  Guards: can't delete yourself; scoped to your company. The `AuditLog` trail is
  preserved.

_Files: `src/app/(dashboard)/admin/employees/page.tsx`, `src/app/api/admin/employees/[id]/route.ts`_

---

## 7. Shifts (`/admin/shifts`)

Shift templates: name, start time, end time, **grace minutes** (how late before
marked "late"), minimum work minutes (full vs half day threshold), night-shift
flag. Full CRUD (create inline, edit dialog, soft-delete via `isActive`).

_Files: `src/app/(dashboard)/admin/shifts/page.tsx`, `src/app/api/shifts/*`_

---

## 8. Schedules (`/admin/schedules`)

Assigns each employee a **site + shift for a specific date**.
- Pick a date → existing entries load pre-filled (marked "saved") → edit the
  dropdowns and **Save** (bulk upsert), or **delete** a row.
- On save, the shift's start/end times are converted to that date's UTC instants
  and stored as `expectedStartAt` / `expectedEndAt`.
- **Important:** the scheduled **site is currently used only for late/grace
  calculation, not to constrain check-in** (see §11 and §19).

_Files: `src/app/(dashboard)/admin/schedules/page.tsx`, `src/app/api/schedules/*`_

---

## 10. Site assignments — permanent vs daily

This is a subtle but important distinction:

- **`EmployeeSiteAssignment` (permanent):** set on employee creation / via the
  assignments API. **This is what check-in uses** to pick which site geofence to
  validate against.
- **`EmployeeSchedule.siteId` (daily):** set on the Schedules page per day. **Not
  used by check-in** today.

So "which site can an employee check in at?" is answered by their permanent
assignments, regardless of the daily schedule. (This is the open item from the
"assign sites every day" discussion — see §19.)

_Files: `src/app/api/assignments/route.ts`, `src/lib/attendance-service.ts` (`findSiteForCheckIn`)_

---

## 11. Check-in flow

When an employee taps **Check in** (`/employee`):

```
1. Browser/app gets current GPS position (lat, lng, accuracy).
2. POST /api/attendance/check-in
3. findSiteForCheckIn(): among the employee's PERMANENT site assignments,
   pick the site they're inside (or nearest).
   └── if none assigned          → "no_assignment"
   └── if outside every geofence → "outside_geofence"
4. Mock-location check: compare to last ping; if implied speed is impossible
   (> MOCK_LOCATION_SPEED_KMH), flag as mock.
5. Upsert AttendanceDay for today (company timezone).
6. Create AttendanceSession (status "active", or "flagged" if mock).
7. Write the first LocationPing + a GeofenceEvent ("entered_site").
8. Determine status using the day's schedule:
   └── late if check-in is past expectedStartAt + graceMinutes → status "late"
   └── otherwise "present"
9. Background tracking starts.
```

_Files: `src/app/api/attendance/check-in/route.ts`, `src/lib/attendance-service.ts`_

---

## 12. Background tracking (pings)

While checked in, the app sends a GPS **ping roughly every 60 seconds**
(`useBackgroundTracker` → `/api/pings`). On Android the background-geolocation
plugin keeps this alive via a foreground service even when the app is closed.
Failed pings are queued by a service worker and retried.

Each ping (`processPings`) does:
- Save a `LocationPing` (location, accuracy, battery, network, app state, mock flag).
- Compute inside/outside the geofence.
- On an **inside↔outside transition**, write a `GeofenceEvent` and:
  - leaving → open an `OutsideSiteLog`
  - returning → close the open `OutsideSiteLog` (records duration)
- Run mock-location detection over the session's pings; flag the day if needed.
- **Trigger automatic check-out** if the employee has gone too far (see §13).

_Files: `src/hooks/useBackgroundTracker.ts`, `src/components/geo/LocationTracker.tsx`, `src/app/api/pings/route.ts`, `src/lib/attendance-service.ts`_

---

## 13. Check-out — manual & automatic

### Manual check-out
Tap **Check out** → `POST /api/attendance/check-out` → `finalizeSession`:
- Stamp `checkOutAt`, location, distance-from-site; session → "completed"
  (or "flagged" if mock).
- Replay the session's pings to total **inside** vs **outside** seconds.
- Update the `AttendanceDay`: `lastCheckOutAt`, `totalWorkSeconds`
  (checkout − checkin), inside/outside totals.
- Close any open outside-site logs.
- Flags: >30 min outside → flag day; <4 h worked → "half_day".

### Automatic check-out (geofence exit)
Added so a session can't stay open forever if someone leaves without checking out:
- During ping processing, if a ping shows the employee **beyond
  `radius + AUTO_CHECKOUT_BUFFER_METERS`** (buffer default **50 m**), the session
  is auto-closed (status **`auto_closed`**, day flagged `auto_checkout_left_site`).
- **Check-out time is backdated** to the moment they crossed the site boundary
  (not when the far ping arrived), so travel/away time isn't counted as worked.
- The client is told (`autoCheckedOut`) and the UI flips back to "Check in" with a
  toast.
- Configurable via `AUTO_CHECKOUT_ENABLED` and `AUTO_CHECKOUT_BUFFER_METERS`.

> Example: a 20 m radius + 50 m buffer → auto-checkout once a ping is **> 70 m**
> from the center; detected within ~1 min (next ping).

_Files: `src/app/api/attendance/check-out/route.ts`, `src/lib/attendance-service.ts`, `src/lib/env.ts`_

---

## 14. Attendance day lifecycle & status

`AttendanceDay` is the per-employee, per-date summary. Its `status` evolves:

```
pending  →  present / late          (at check-in)
present  →  half_day                (at check-out if < 4h worked)
         →  isFlagged + flagReasons (mock location, >30 min outside, auto-checkout)
```

The `absent` status exists in the model but is **not
auto-populated** by current logic (see §19).

_Files: `src/models/AttendanceDay.ts`, `src/lib/attendance-service.ts`_

---

## 17. Reports

### Attendance report (`/admin/reports`)
- Filter by date range, site, employee. Scoped by role (employee = self,
  admin = company).
- Rows are `AttendanceDay` records enriched with employee name/code/email.
- **CSV export** columns: Date, Employee Code, Name, Email, Status, Check-in,
  Check-out, Work(sec), Inside(sec), Outside(sec), Late(min), Flagged, Flag Reasons.
- No heavy aggregation — totals are precomputed at check-out.

### Today summary (dashboards)
Counts for today across the role's scope: total, present, late, absent, half_day,
flagged (computed in the company timezone).

_Files: `src/app/api/reports/attendance/route.ts`, `src/app/api/reports/attendance/today/route.ts`_

---

## 18. Audit log (`/admin/audit`)

- Model + read-only API + UI page all exist.
- **But nothing writes audit entries.** A repo-wide search for `AuditLog.create`
  returns nothing — so the page is effectively always empty. This is a stub. (See §19.)

_Files: `src/models/AuditLog.ts`, `src/app/api/audit/route.ts`, `src/app/(dashboard)/admin/audit/page.tsx`_

---

## 19. Gaps & improvement opportunities

A consolidated list of things that are missing, inconsistent, or worth rethinking —
use this as the starting point for your suggestions.

**Attendance correctness**
1. **Daily site assignment isn't enforced at check-in.** The Schedules page sets a
   site per day, but check-in validates against *permanent* assignments. Decide
   whether the daily site should drive/limit check-in.
3. **`absent` is never set automatically.** Nothing marks employees absent for days
   with no check-in (would need a scheduled job).

**Feature completeness**
5. **Audit logging is a stub** — wire `AuditLog.create` into create/update/delete
   (and the new hard-delete) so the audit page is meaningful.
6. **No "reactivate" button** for inactive employees (the API supports it; only the
   toggle does now — actually the toggle does cover this, but verify UX).
8. **Password change / admin-initiated password reset** for employees isn't exposed.

**Consistency / polish**
9. **Hard vs soft delete is inconsistent** — sites/employees… employees now hard-
   delete with cascade, while sites/shifts soft-delete (`isActive`) and other records
   hard-delete. Decide on one policy per entity and document it.
10. **Leave creation doesn't check role** (any authenticated user could create one).
11. **Auto-checkout buffer is global**, not per-site — a per-site buffer/radius may
    fit sites of different sizes better.
12. **Reports have no pagination** — large date ranges return everything at once.

**Operational**
13. **No background job runner** — auto-absent, end-of-shift session closing, and
    all need a scheduler (cron) beyond the existing close-shifts job.
14. **Audit/IP/user-agent capture** isn't recorded anywhere.

---

## 20. Configuration (environment variables)

Set these in the deploy environment (Vercel):

| Variable | Purpose | Notes |
|----------|---------|-------|
| `MONGODB_URI` | Database connection | required |
| `MONGODB_DB_NAME` | DB name | default `attendance` |
| `NEXTAUTH_SECRET` | JWT signing | **required in prod, ≥16 chars (build fails without it)** |
| `NEXTAUTH_URL` | Canonical app URL | required in prod |
| `DEFAULT_TIMEZONE` | Fallback timezone | default `Asia/Kolkata` |
| `PING_INTERVAL_MS` | Server-side ping cadence hint | default 180000 |
| `MOCK_LOCATION_SPEED_KMH` | Speed above which a jump = mock | default 200 |
| `AUTO_CHECKOUT_ENABLED` | Toggle geofence auto-checkout | default true |
| `AUTO_CHECKOUT_BUFFER_METERS` | Distance beyond radius to auto-checkout | default 50 |
| `SMTP_*`, `EMAIL_FROM` | Outbound email | optional (console fallback) |

_Files: `src/lib/env.ts`_

---

## 21. Deploying an update

1. Commit changes.
2. `git push origin main` → Vercel auto-builds & deploys to production.
3. The Android app loads the new version on next launch — **no APK rebuild** for
   web/logic changes. (Rebuild the APK only for native changes: plugins,
   permissions, app icon, or `capacitor.config.ts`.)
