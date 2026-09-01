"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { toast } from "@/components/ui/toaster";
import { CalendarRange, Trash2 } from "lucide-react";

type RangeRow = { include: boolean; siteId: string; shiftTemplateId: string };

const today = () => new Date().toISOString().slice(0, 10);

export default function SchedulesPage() {
  const [employees, setEmployees] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [shifts, setShifts] = useState<any[]>([]);

  // --- Range assignment state ---
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [skipSundays, setSkipSundays] = useState(true);
  const [rangeRows, setRangeRows] = useState<Record<string, RangeRow>>({});
  const [generating, setGenerating] = useState(false);

  // --- Review-by-date state ---
  const [reviewDate, setReviewDate] = useState(today);
  const [reviewRows, setReviewRows] = useState<any[]>([]);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/employees").then((r) => r.json()),
      fetch("/api/sites").then((r) => r.json()),
      fetch("/api/shifts").then((r) => r.json()),
    ]).then(([e, s, sh]: any[]) => {
      if (e.ok) setEmployees(e.data.employees || []);
      if (s.ok) setSites(s.data.sites || []);
      if (sh.ok) setShifts(sh.data.shifts || []);
    });
  }, []);

  // Initialise a range row per employee once the dropdown data is available.
  useEffect(() => {
    if (!employees.length) return;
    setRangeRows((prev) => {
      const next = { ...prev };
      for (const e of employees) {
        if (!next[e.id]) {
          next[e.id] = {
            include: true,
            siteId: sites[0]?._id || "",
            shiftTemplateId: shifts[0]?._id || "",
          };
        }
      }
      return next;
    });
  }, [employees, sites, shifts]);

  const empById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const e of employees) m[e.id] = e;
    return m;
  }, [employees]);
  const siteById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const s of sites) m[s._id] = s;
    return m;
  }, [sites]);
  const shiftById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const s of shifts) m[s._id] = s;
    return m;
  }, [shifts]);

  function setRangeRow(empId: string, partial: Partial<RangeRow>) {
    setRangeRows((r) => ({
      ...r,
      [empId]: {
        include: r[empId]?.include ?? true,
        siteId: r[empId]?.siteId || sites[0]?._id || "",
        shiftTemplateId: r[empId]?.shiftTemplateId || shifts[0]?._id || "",
        ...partial,
      },
    }));
  }

  function toggleAll(include: boolean) {
    setRangeRows((r) => {
      const next = { ...r };
      for (const e of employees) {
        next[e.id] = {
          include,
          siteId: next[e.id]?.siteId || sites[0]?._id || "",
          shiftTemplateId: next[e.id]?.shiftTemplateId || shifts[0]?._id || "",
        };
      }
      return next;
    });
  }

  const includedCount = employees.filter((e) => rangeRows[e.id]?.include).length;

  async function generate() {
    if (toDate < fromDate) {
      toast({ title: "End date must be on or after the start date", variant: "destructive" });
      return;
    }
    const entries = employees
      .filter((e) => rangeRows[e.id]?.include && rangeRows[e.id]?.siteId && rangeRows[e.id]?.shiftTemplateId)
      .map((e) => ({
        employeeId: e.id,
        siteId: rangeRows[e.id].siteId,
        shiftTemplateId: rangeRows[e.id].shiftTemplateId,
      }));
    if (entries.length === 0) {
      toast({ title: "Select at least one employee with a site and shift", variant: "destructive" });
      return;
    }
    setGenerating(true);
    const res = await fetch("/api/schedules/range", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromDate, toDate, skipSundays, entries }),
    });
    const json = await res.json();
    setGenerating(false);
    if (json.ok) {
      const d = json.data;
      toast({
        title: `Scheduled ${d.employees} employee(s)`,
        description: `${d.totalDays} day(s): ${d.workingDays} working, ${d.offDays} off (Sundays/holidays).`,
      });
      loadReview(reviewDate);
    } else {
      toast({ title: "Failed", description: json.error, variant: "destructive" });
    }
  }

  const loadReview = useCallback(async (date: string) => {
    const r = await fetch(`/api/schedules?from=${date}&to=${date}`);
    const j = await r.json();
    if (j.ok) setReviewRows(j.data.schedules || []);
  }, []);

  useEffect(() => {
    loadReview(reviewDate);
  }, [reviewDate, loadReview]);

  async function removeSchedule(id: string) {
    if (!confirm("Delete this schedule entry?")) return;
    const r = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (r.ok) {
      toast({ title: "Schedule deleted" });
      loadReview(reviewDate);
    } else {
      toast({ title: "Delete failed", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Schedules</h1>

      {/* ---- Assign over a date range ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Assign shifts over a date range</CardTitle>
          <CardDescription>
            Pick a start and end date, choose each employee&apos;s site and shift, and generate.
            Sundays and company holidays in the range are automatically marked as days off
            (no check-in required).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label>From date</Label>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </div>
            <div>
              <Label>To date</Label>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-sm sm:self-end sm:pb-2">
              <input type="checkbox" checked={skipSundays} onChange={(e) => setSkipSundays(e.target.checked)} />
              Skip Sundays
            </label>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{includedCount} selected</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => toggleAll(true)}>Select all</Button>
              <Button variant="outline" size="sm" onClick={() => toggleAll(false)}>Clear</Button>
            </div>
          </div>

          <div className="space-y-2">
            {employees.map((e) => {
              const row = rangeRows[e.id] || { include: true, siteId: "", shiftTemplateId: "" };
              return (
                <div key={e.id} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 sm:items-center border-b pb-2">
                  <label className="flex items-center gap-2 font-medium lg:col-span-2">
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(ev) => setRangeRow(e.id, { include: ev.target.checked })}
                    />
                    {e.fullName}
                  </label>
                  <select
                    className="w-full border rounded-md px-2 py-1 text-sm lg:col-span-2"
                    value={row.siteId}
                    disabled={!row.include}
                    onChange={(ev) => setRangeRow(e.id, { siteId: ev.target.value })}
                  >
                    <option value="">Select site</option>
                    {sites.map((s) => (
                      <option key={s._id} value={s._id}>{s.name}</option>
                    ))}
                  </select>
                  <select
                    className="w-full border rounded-md px-2 py-1 text-sm lg:col-span-2"
                    value={row.shiftTemplateId}
                    disabled={!row.include}
                    onChange={(ev) => setRangeRow(e.id, { shiftTemplateId: ev.target.value })}
                  >
                    <option value="">Select shift</option>
                    {shifts.map((s) => (
                      <option key={s._id} value={s._id}>{s.name} ({s.startTime}-{s.endTime})</option>
                    ))}
                  </select>
                </div>
              );
            })}
            {employees.length === 0 && <p className="text-muted-foreground text-sm">No employees yet.</p>}
          </div>

          <Button onClick={generate} disabled={generating} className="gap-2">
            <CalendarRange className="h-4 w-4" />
            {generating ? "Generating…" : "Generate schedule"}
          </Button>
        </CardContent>
      </Card>

      {/* ---- Review / delete by date ---- */}
      <Card>
        <CardHeader>
          <CardTitle>Review a date</CardTitle>
          <CardDescription>See what&apos;s scheduled on a given day and remove entries.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs">
            <Label>Date</Label>
            <Input type="date" value={reviewDate} onChange={(e) => setReviewDate(e.target.value)} />
          </div>

          <div className="space-y-2">
            {reviewRows.length === 0 && (
              <p className="text-sm text-muted-foreground">Nothing scheduled on this date.</p>
            )}
            {reviewRows.map((s) => {
              const emp = empById[String(s.employeeId)];
              const site = siteById[String(s.siteId)];
              const shift = shiftById[String(s.shiftTemplateId)];
              return (
                <div key={s._id} className="flex items-center justify-between gap-2 border-b pb-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{emp?.fullName || "Unknown employee"}</p>
                    <p className="text-muted-foreground truncate">
                      {site?.name || "—"} · {shift?.name || "—"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.isWorkingDay ? (
                      <Badge variant="success">working</Badge>
                    ) : (
                      <Badge variant="secondary">day off</Badge>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => removeSchedule(s._id)} aria-label="Delete schedule">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
