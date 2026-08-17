import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = { title: "Reset password — Geo Attendance" };

// Background, centering and branding come from the (auth) route-group layout.
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
