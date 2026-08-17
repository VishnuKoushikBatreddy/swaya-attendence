/**
 * Single source of truth for dashboard navigation.
 *
 * Sidebar (md+) and MobileNav (below md) previously each carried their own copy
 * of these arrays, so adding a route meant editing two files and the two menus
 * could silently drift apart. Both now read from here.
 */
import {
  LayoutDashboard,
  MapPin,
  Users as UsersIcon,
  Clock,
  Calendar,
  ClipboardList,
  FileText,
  Settings,
  Building,
  Plane,
  type LucideIcon,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon };

const empNav: NavItem[] = [
  { href: "/employee", label: "Today's check-in", icon: Clock },
  { href: "/employee/history", label: "History", icon: Calendar },
  { href: "/employee/leave", label: "Leave", icon: Plane },
  { href: "/employee/regularization", label: "Regularization", icon: ClipboardList },
  { href: "/employee/sites", label: "My sites", icon: MapPin },
];

const mgrNav: NavItem[] = [
  { href: "/manager", label: "Team", icon: UsersIcon },
  { href: "/manager/approvals", label: "Approvals", icon: ClipboardList },
  { href: "/manager/reports", label: "Reports", icon: FileText },
];

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/sites", label: "Sites", icon: MapPin },
  { href: "/admin/employees", label: "Employees", icon: UsersIcon },
  { href: "/admin/shifts", label: "Shifts", icon: Clock },
  { href: "/admin/schedules", label: "Schedules", icon: Calendar },
  { href: "/admin/holidays", label: "Holidays", icon: FileText },
  { href: "/admin/approvals", label: "Approvals", icon: ClipboardList },
  { href: "/admin/reports", label: "Reports", icon: FileText },
  { href: "/admin/audit", label: "Audit", icon: Settings },
];

const superNav: NavItem[] = [
  { href: "/super-admin", label: "Overview", icon: LayoutDashboard },
  { href: "/super-admin/companies", label: "Companies", icon: Building },
  { href: "/super-admin/users", label: "Users", icon: UsersIcon },
];

export function getNav(role: string): NavItem[] {
  if (role === "super_admin") return superNav;
  if (role === "admin") return adminNav;
  if (role === "manager") return mgrNav;
  return empNav;
}

/**
 * Which nav item the current path belongs to.
 *
 * A plain `pathname.startsWith(href)` test lights up two items at once, because
 * every section's index route ("/admin", "/employee") is a prefix of all its
 * children — on /employee/history both "Today's check-in" and "History" appeared
 * selected. Matching the LONGEST href instead means exactly one item is ever
 * active, and section roots stay highlighted on their own page.
 */
export function activeHref(nav: NavItem[], pathname: string): string | null {
  let best: string | null = null;
  for (const item of nav) {
    const matches = pathname === item.href || pathname.startsWith(item.href + "/");
    if (matches && (best === null || item.href.length > best.length)) {
      best = item.href;
    }
  }
  return best;
}
