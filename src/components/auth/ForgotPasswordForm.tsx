"use client";

import { useState } from "react";
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

const Schema = z.object({ email: z.string().email() });
type Input = z.infer<typeof Schema>;

export function ForgotPasswordForm() {
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<Input>({ resolver: zodResolver(Schema) });

  async function onSubmit(values: Input) {
    setLoading(true);
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    setLoading(false);
    const json = await res.json();
    if (json.ok) {
      setDone(true);
      toast({ title: "Check your inbox (or the server console in dev)" });
    } else {
      toast({ title: "Something went wrong", variant: "destructive" });
    }
  }

  return (
    <Card className="w-full max-w-md shadow-lg shadow-black/5">
      <CardHeader>
        <CardTitle>Forgot password</CardTitle>
        <CardDescription>
          We&apos;ll email you a link to reset your password.
        </CardDescription>
      </CardHeader>
      {done ? (
        <CardContent>
          <p className="text-sm">If the email exists, a reset link has been sent.</p>
        </CardContent>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...register("email")} />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email.message}</p>
              )}
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Sending…" : "Send reset link"}
            </Button>
            <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
              Back to sign in
            </Link>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}
