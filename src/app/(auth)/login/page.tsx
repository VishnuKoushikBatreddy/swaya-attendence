import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "Sign in — Geo Attendance" };

// Background, centering and branding come from the (auth) route-group layout.
export default function LoginPage() {
  return <LoginForm />;
}
