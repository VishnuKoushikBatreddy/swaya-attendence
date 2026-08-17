import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Create your company — Geo Attendance" };

// Background, centering and branding come from the (auth) route-group layout.
export default function SignupPage() {
  return <SignupForm />;
}
