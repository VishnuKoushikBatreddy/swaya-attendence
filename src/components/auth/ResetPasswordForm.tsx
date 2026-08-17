"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from "@/components/ui/card";
import { toast } from "@/components/ui/toaster";
import Link from "next/link";

const Schema = z.object({ password: z.string().min(8) });
type Input = z.infer<typeof Schema>;

function Inner() {
  const router = useRouter();
  const search = useSearchParams();
  const token = search.get("token") || "";
  const [loading, setLoading] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(Schema) });

  async function onSubmit(values: Input) {
    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: values.password }),
    });
    setLoading(false);
    const json = await res.json();
    if (json.ok) {
      toast({ title: "Password reset. Please sign in." });
      router.push("/login");
    } else {
      toast({ title: "Reset failed", variant: "destructive" });
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-md shadow-lg shadow-black/5">
        <CardHeader>
          <CardTitle>Invalid link</CardTitle>
          <CardDescription>This password reset link is missing or invalid.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/forgot-password" className="text-sm text-primary">
            Request a new link
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md shadow-lg shadow-black/5">
      <CardHeader>
        <CardTitle>Set a new password</CardTitle>
        <CardDescription>Enter a new password for your account.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input id="password" type="password" {...register("password")} />
            {errors.password && (
              <p className="text-sm text-destructive">{errors.password.message}</p>
            )}
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Resetting…" : "Reset password"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function ResetPasswordForm() {
  return (
    <Suspense fallback={null}>
      <Inner />
    </Suspense>
  );
}
