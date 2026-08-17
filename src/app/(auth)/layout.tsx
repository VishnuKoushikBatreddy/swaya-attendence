/**
 * Shared shell for the signed-out screens (login, signup, forgot/reset password).
 *
 * All four pages previously repeated the same wrapper div with a hardcoded
 * blue/indigo gradient, so restyling auth meant editing four files and the
 * gradient ignored the theme tokens. The branding and background live here now;
 * each page renders only its form.
 */
import { MapPin } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Two soft, theme-derived washes instead of a fixed palette gradient, so
          the backdrop follows --primary and works in both schemes. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-primary/15 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-40 h-[28rem] w-[28rem] rounded-full bg-info/10 blur-3xl"
      />

      <div className="relative z-10 flex w-full max-w-md flex-col items-center gap-6">
        <div className="flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <MapPin className="h-5 w-5" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Geo Attendance</span>
        </div>
        {children}
      </div>
    </div>
  );
}
