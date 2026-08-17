"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Users, MapPin, CheckCircle2, AlertCircle } from "lucide-react";

export default function AdminOverview() {
  const [stats, setStats] = useState<{ employees: number; sites: number; presentToday: number; flagged: number } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/employees").then((r) => r.json()),
      fetch("/api/sites").then((r) => r.json()),
      fetch("/api/reports/attendance/today").then((r) => r.json()),
    ]).then(([emp, sites, today]: any[]) => {
      setStats({
        employees: emp.ok ? emp.data.employees.length : 0,
        sites: sites.ok ? sites.data.sites.length : 0,
        presentToday: today.ok ? today.data.summary.present : 0,
        flagged: today.ok ? today.data.summary.flagged : 0,
      });
    });
  }, []);

  const cards = [
    { title: "Employees", value: stats?.employees, icon: Users, color: "text-blue-600" },
    { title: "Active sites", value: stats?.sites, icon: MapPin, color: "text-success" },
    { title: "Present today", value: stats?.presentToday, icon: CheckCircle2, color: "text-success" },
    { title: "Flagged today", value: stats?.flagged, icon: AlertCircle, color: "text-warning" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.title}>
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{c.title}</p>
                  <p className="text-2xl font-bold">{c.value ?? "…"}</p>
                </div>
                <Icon className={`h-8 w-8 ${c.color}`} />
              </CardContent>
            </Card>
          );
        })}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Welcome</CardTitle>
          <CardDescription>Use the sidebar to manage sites, employees, shifts, and schedules.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Reports are available under <a href="/admin/reports" className="text-primary underline">Reports</a>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}