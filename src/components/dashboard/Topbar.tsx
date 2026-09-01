"use client";

import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getNav, activeHref } from "./nav-items";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  employee: "Employee",
};

export function Topbar({
  userId,
  name,
  role,
  companyId,
}: {
  userId: string;
  name: string;
  role: string;
  companyId: string;
}) {
  const pathname = usePathname();
  const roleLabel = ROLE_LABEL[role] || role;
  const initials =
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2) || "U";

  // Name the page the user is on. The bar previously repeated "Logged in as
  // <role>", which the sidebar already shows — a title is the more useful use
  // of the space, and on mobile (sidebar hidden) it's the only orientation cue.
  const nav = getNav(role);
  const active = activeHref(nav, pathname);
  const title = nav.find((i) => i.href === active)?.label ?? roleLabel;

  return (
    <header className="sticky top-0 z-30 flex h-16 flex-shrink-0 items-center justify-between gap-2 border-b bg-card/95 pl-14 pr-3 backdrop-blur supports-[backdrop-filter]:bg-card/80 md:px-6">
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-base font-semibold tracking-tight">{title}</h1>
        <span className="truncate text-xs text-muted-foreground md:hidden">{roleLabel}</span>
      </div>

      <div className="flex flex-shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => window.location.reload()}
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw className="h-5 w-5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="max-w-[45vw] gap-2 px-2 sm:max-w-none">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                {initials}
              </span>
              <span className="hidden truncate sm:inline">{name}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="block truncate text-xs text-muted-foreground">{roleLabel}</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => signOut({ callbackUrl: "/login" })}>
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
