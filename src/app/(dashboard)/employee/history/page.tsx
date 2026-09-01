"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatDuration } from "@/lib/utils";

export default function HistoryPage() {
  const { data: session } = useSession();
  const [days, setDays] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/attendance/history")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setDays(j.data.days || []);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Card><CardContent className="p-6">Loading...</CardContent></Card>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Attendance History</h1>

      {days.length === 0 ? (
        <Card><CardContent className="p-6">No records yet.</CardContent></Card>
      ) : (
        days.map((d) => (
          <Card key={d._id}>
            <CardHeader className="pb-2">
              <div className="flex justify-between">
                <CardTitle className="text-base">{d.workDate}</CardTitle>
                <Badge
                  variant={
                    d.status === "present"
                      ? "success"
                      : d.status === "late"
                      ? "warning"
                      : d.status === "absent"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {d.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">In</span>
                <p className="font-medium">{d.firstCheckInAt ? new Date(d.firstCheckInAt).toLocaleTimeString() : "—"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Out</span>
                <p className="font-medium">{d.lastCheckOutAt ? new Date(d.lastCheckOutAt).toLocaleTimeString() : "—"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Work</span>
                <p className="font-medium">{formatDuration(d.totalWorkSeconds)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Outside</span>
                <p className="font-medium">{formatDuration(d.totalOutsideSeconds)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Offline</span>
                <p className="font-medium">{formatDuration(d.totalOfflineSeconds || 0)}</p>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}