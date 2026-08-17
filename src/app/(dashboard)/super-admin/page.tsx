"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Building, Users, CheckCircle2 } from "lucide-react";

export default function SuperAdminOverview() {
  const [stats, setStats] = useState<{ companies: number; users: number; active: number } | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/companies").then((r) => r.json()),
      fetch("/api/admin/users").then((r) => r.json()),
    ]).then(([c, u]: any[]) => {
      setStats({
        companies: c.ok ? c.data.companies.length : 0,
        users: u.ok ? u.data.users.length : 0,
        active: c.ok ? c.data.companies.filter((x: any) => x.isActive).length : 0,
      });
    });
  }, []);

  const cards = [
    { title: "Total companies", value: stats?.companies, icon: Building, color: "text-blue-600" },
    { title: "Active companies", value: stats?.active, icon: CheckCircle2, color: "text-success" },
    { title: "Total users", value: stats?.users, icon: Users, color: "text-indigo-600" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          <CardTitle>Welcome, Super Admin</CardTitle>
          <CardDescription>Manage all companies on the platform.</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}