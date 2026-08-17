import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "Forgot password — Geo Attendance" };

// Background, centering and branding come from the (auth) route-group layout.
export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
