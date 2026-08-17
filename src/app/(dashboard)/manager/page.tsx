"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, CheckCircle2, AlertCircle, Clock } from "lucide-react";
import { formatDuration } from "@/lib/utils";

export default function ManagerOverview() {
  const [team, setTeam] = useState<any[]>([]);
  const [today, setToday] = useState<any>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/admin/employees").then((r) => r.json()),
      fetch("/api/reports/attendance/today").then((r) => r.json()),
    ]).then(([e, t]: any[]) => {
      if (e.ok) setTeam(e.data.employees || []);
      if (t.ok) setToday(t.data);
    });
  }, []);

  const cards = [
    { title: "Team size", value: team.length, icon: Users, color: "text-blue-600" },
    { title: "Present", value: today?.summary?.present ?? 0, icon: CheckCircle2, color: "text-success" },
    { title: "Late", value: today?.summary?.late ?? 0, icon: Clock, color: "text-warning" },
    { title: "Flagged", value: today?.summary?.flagged ?? 0, icon: AlertCircle, color: "text-destructive" },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Team</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.title}>
              <CardContent className="p-6 flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">{c.title}</p>
                  <p className="text-2xl font-bold">{c.value}</p>
                </div>
                <Icon className={`h-8 w-8 ${c.color}`} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team members</CardTitle>
          <CardDescription>People on your team</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {team.length === 0 ? (
              <p className="text-muted-foreground text-sm">No team members yet.</p>
            ) : (
              team.map((m) => {
                const day = today?.days?.find?.((d: any) => String(d.employeeId) === m.id);
                return (
                  <div key={m.id} className="flex items-center justify-between border-b pb-2">
                    <div>
                      <p className="font-medium">{m.fullName}</p>
                      <p className="text-xs text-muted-foreground">{m.email}</p>
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      {day ? (
                        <>
                          <Badge variant={
                            day.status === "present" ? "success" :
                            day.status === "late" ? "warning" :
                            day.status === "absent" ? "destructive" : "secondary"
                          }>{day.status}</Badge>
                          <span className="text-muted-foreground">{formatDuration(day.totalWorkSeconds || 0)}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground text-sm">No record</span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}