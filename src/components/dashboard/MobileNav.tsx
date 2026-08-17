"use client";

/**
 * MobileNav — hamburger drawer for phone-width viewports.
 *
 * Hidden on md+ breakpoints where the desktop Sidebar takes over. The drawer
 * uses Radix Dialog (already in package.json) and renders the same nav items as
 * Sidebar.tsx — both import them from ./nav-items, so the two menus cannot drift.
 *
 * Place it once at the top of the dashboard layout alongside <Sidebar>.
 * The hamburger trigger floats on the left edge of the viewport so it works
 * regardless of where the topbar lives in the DOM.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { LogOut, Menu, MapPin } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getNav, activeHref } from "./nav-items";

export function MobileNav({ role }: { role: string }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const nav = getNav(role);
  const active = activeHref(nav, pathname);

  // Close the drawer whenever the user navigates so it doesn't stay open
  // over a different page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <>
      {/* Hamburger trigger — only visible below md. Floats over the topbar. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="fixed left-2 top-3 z-40 h-10 w-10 md:hidden"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="left-0 top-0 flex h-screen max-h-screen w-72 max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none p-0 data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left"
        >
          <DialogTitle className="sr-only">Navigation</DialogTitle>

          <div className="flex h-16 flex-shrink-0 items-center gap-2.5 border-b px-5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MapPin className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Geo Attendance</span>
          </div>

          {/* flex-1 + overflow keeps long menus scrollable instead of running
              underneath the account block, which was absolutely positioned. */}
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
                    "group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary transition-opacity",
                      isActive ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <Icon
                    className={cn(
                      "h-4 w-4 flex-shrink-0",
                      isActive ? "text-primary" : "text-muted-foreground"
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex-shrink-0 border-t p-3">
            <div className="truncate px-2 pb-2 text-xs text-muted-foreground">
              {session?.user?.email}
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
        </DialogContent>
      </Dialog>
    </>
  );
}
