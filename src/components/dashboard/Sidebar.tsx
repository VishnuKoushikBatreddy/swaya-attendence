"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { LogOut, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getNav, activeHref } from "./nav-items";

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super admin",
  admin: "Admin",
  manager: "Manager",
  employee: "Employee",
};

export function Sidebar({ role }: { role: string }) {
  const pathname = usePathname();
  const { data: session } = useSession();

  const nav = getNav(role);
  const active = activeHref(nav, pathname);
  const name = session?.user?.name || "";
  const initials =
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "U";

  return (
    <aside className="hidden w-64 flex-shrink-0 flex-col border-r bg-card md:flex">
      {/* Brand */}
      <div className="flex h-16 items-center gap-2.5 border-b px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MapPin className="h-4 w-4" />
        </span>
        <span className="flex flex-col leading-none">
          <span className="text-sm font-semibold tracking-tight">Geo Attendance</span>
          <span className="mt-1 text-[11px] font-medium text-muted-foreground">
            {ROLE_LABEL[role] ?? role}
          </span>
        </span>
      </div>

      {/* Primary navigation. flex-1 pushes the account block to the bottom. */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {nav.map((item) => {
          const isActive = item.href === active;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
              )}
            >
              {/* Accent rail marks the active item without repainting the whole
                  row in primary, which was heavy next to a map-dense page. */}
              <span
                className={cn(
                  "absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
                  isActive ? "opacity-100" : "opacity-0"
                )}
              />
              <Icon
                className={cn(
                  "h-4 w-4 flex-shrink-0 transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-accent-foreground"
                )}
              />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Account */}
      <div className="border-t p-3">
        <div className="mb-2 flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            {initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {session?.user?.email}
            </span>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => signOut({ callbackUrl: "/login" })}
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </div>
    </aside>
  );
}
