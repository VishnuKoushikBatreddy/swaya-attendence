"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toaster";
import { formatDate } from "@/lib/utils";

const Schema = z.object({
  requestType: z.enum([
    "forgot_check_in",
    "forgot_check_out",
    "gps_issue",
    "outside_site_reason",
    "manual_correction",
  ]),
  reason: z.string().min(5),
  requestedCheckInAt: z.string().optional(),
  requestedCheckOutAt: z.string().optional(),
});

export default function RegularizationPage() {
  const { data: session } = useSession();
  const [myRequests, setMyRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<z.infer<typeof Schema>>({
    resolver: zodResolver(Schema),
    defaultValues: { requestType: undefined, reason: "" },
  });

  useEffect(() => {
    fetch("/api/regularization")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setMyRequests(j.data.requests || []);
      });
  }, []);

  async function onSubmit(values: z.infer<typeof Schema>) {
    setLoading(true);
    // Get today's attendance day id
    const todayRes = await fetch("/api/attendance/today");
    const todayJson = await todayRes.json();
    if (!todayJson.ok || !todayJson.data.day) {
      toast({ title: "No attendance day found", variant: "destructive" });
      setLoading(false);
      return;
    }

    const res = await fetch("/api/regularization", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attendanceDayId: todayJson.data.day._id,
        ...values,
      }),
    });
    const json = await res.json();
    setLoading(false);
    if (json.ok) {
      toast({ title: "Request submitted" });
      reset();
      // refresh list
      const refresh = await fetch("/api/regularization");
      const j = await refresh.json();
      if (j.ok) setMyRequests(j.data.requests || []);
    } else {
      toast({ title: "Failed", description: json.error, variant: "destructive" });
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Regularization</h1>

      <Card>
        <CardHeader>
          <CardTitle>Request correction</CardTitle>
          <CardDescription>
            If your attendance was recorded incorrectly, submit a regularization request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              {/* Radix Select manages its own state — use Controller so the
                  value flows into react-hook-form's submitted payload. */}
              <Controller
                control={control}
                name="requestType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="forgot_check_in">Forgot check-in</SelectItem>
                      <SelectItem value="forgot_check_out">Forgot check-out</SelectItem>
                      <SelectItem value="gps_issue">GPS issue</SelectItem>
                      <SelectItem value="outside_site_reason">Outside site reason</SelectItem>
                      <SelectItem value="manual_correction">Manual correction</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.requestType && (
                <p className="text-sm text-destructive">{errors.requestType.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Reason</Label>
              <Textarea {...register("reason")} placeholder="Explain why..." />
              {errors.reason && (
                <p className="text-sm text-destructive">{errors.reason.message}</p>
              )}
            </div>

            <Button type="submit" disabled={loading}>
              {loading ? "Submitting…" : "Submit request"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>My requests</CardTitle>
        </CardHeader>
        <CardContent>
          {myRequests.length === 0 ? (
            <p className="text-muted-foreground">No requests yet.</p>
          ) : (
            <div className="space-y-3">
              {myRequests.map((r) => (
                <div key={r._id} className="flex items-center justify-between border-b pb-2">
                  <div>
                    <p className="font-medium">{r.requestType}</p>
                    <p className="text-sm text-muted-foreground">{r.reason}</p>
                  </div>
                  <span
                    className={
                      r.status === "pending"
                        ? "text-warning"
                        : r.status === "approved"
                        ? "text-success"
                        : "text-destructive"
                    }
                  >
                    {r.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}