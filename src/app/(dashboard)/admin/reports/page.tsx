"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatDuration } from "@/lib/utils";

export default function AdminReportsPage() {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [employeeId, setEmployeeId] = useState("");
  const [employees, setEmployees] = useState<any[]>([]);
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/admin/employees")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setEmployees(j.data.employees || []);
      });
  }, []);

  async function load() {
    const params = new URLSearchParams({ from, to });
    if (employeeId) params.set("employeeId", employeeId);
    const r = await fetch(`/api/reports/attendance?${params}`);
    const j = await r.json();
    if (j.ok) setRows(j.data.rows || []);
  }
  useEffect(() => {
    load();
  }, []);

  function downloadCsv() {
    const params = new URLSearchParams({ from, to, format: "csv" });
    if (employeeId) params.set("employeeId", employeeId);
    window.open(`/api/reports/attendance?${params}`, "_blank");
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Reports</h1>
      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <Label>From</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div>
              <Label>To</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <div>
              <Label>Employee</Label>
              <select
                className="border rounded-md px-2 py-1 text-sm w-full h-9"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
              >
                <option value="">All</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>{e.fullName}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <Button onClick={load}>Apply</Button>
              <Button variant="outline" onClick={downloadCsv}>Download CSV</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="p-3">Date</th>
                <th className="p-3">Employee</th>
                <th className="p-3">Status</th>
                <th className="p-3">In</th>
                <th className="p-3">Out</th>
                <th className="p-3">Check-outs</th>
                <th className="p-3">Work</th>
                <th className="p-3">Outside</th>
                <th className="p-3">Offline</th>
                <th className="p-3">Flagged</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id} className="border-b">
                  <td className="p-3">{r.workDate}</td>
                  <td className="p-3">{r.employeeName}</td>
                  <td className="p-3">{r.status}</td>
                  <td className="p-3">{r.firstCheckInAt ? formatDateTime(r.firstCheckInAt) : "—"}</td>
                  <td className="p-3">{r.lastCheckOutAt ? formatDateTime(r.lastCheckOutAt) : "—"}</td>
                  <td className="p-3">{r.checkOutCount ?? 0}</td>
                  <td className="p-3">{formatDuration(r.totalWorkSeconds)}</td>
                  <td className="p-3">{formatDuration(r.totalOutsideSeconds)}</td>
                  <td className="p-3">{formatDuration(r.totalOfflineSeconds || 0)}</td>
                  <td className="p-3">{r.isFlagged ? "Yes" : ""}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="p-6 text-center text-muted-foreground">No records in range</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}