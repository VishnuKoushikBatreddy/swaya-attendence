"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { SignupSchema, type SignupInput } from "@/lib/validators";
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

export function SignupForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    defaultValues: { timezone: "Asia/Kolkata" },
  });

  async function onSubmit(values: SignupInput) {
    setLoading(true);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) {
      setLoading(false);
      toast({ title: "Sign up failed", description: json.error, variant: "destructive" });
      return;
    }
    // Auto-login
    const signinRes = await signIn("credentials", {
      redirect: false,
      email: values.email,
      password: values.password,
    });
    setLoading(false);
    if (signinRes?.error) {
      toast({ title: "Account created, please sign in" });
      router.push("/login");
      return;
    }
    toast({ title: "Welcome to Geo Attendance!" });
    router.push("/admin");
    router.refresh();
  }

  return (
    <Card className="w-full max-w-md shadow-lg shadow-black/5">
      <CardHeader>
        <CardTitle>Create your company</CardTitle>
        <CardDescription>You&apos;ll be the first admin of a new workspace.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit(onSubmit)}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="companyName">Company name</Label>
            <Input id="companyName" {...register("companyName")} />
            {errors.companyName && (
              <p className="text-sm text-destructive">{errors.companyName.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="fullName">Your full name</Label>
            <Input id="fullName" {...register("fullName")} />
            {errors.fullName && (
              <p className="text-sm text-destructive">{errors.fullName.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" {...register("email")} />
            {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" {...register("password")} />
            {errors.password && (
              <p className="text-sm text-destructive">{errors.password.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Input id="timezone" {...register("timezone")} />
            <p className="text-xs text-muted-foreground">e.g. Asia/Kolkata, America/New_York</p>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-2">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating…" : "Create company"}
          </Button>
          <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
            Already have an account? Sign in
          </Link>
        </CardFooter>
      </form>
    </Card>
  );
}
