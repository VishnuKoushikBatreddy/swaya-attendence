/**
 * Navigation selection. The important property is that exactly ONE item is ever
 * active: a naive prefix match highlighted both a section root and its child.
 */
import { describe, it, expect } from "vitest";
import { getNav, activeHref } from "@/components/dashboard/nav-items";

describe("getNav", () => {
  it("maps each role to its own menu", () => {
    expect(getNav("employee").map((i) => i.href)).toContain("/employee/history");
    expect(getNav("admin").map((i) => i.href)).toContain("/admin/audit");
    // Only two roles exist; anything that is not admin gets the employee menu.
    expect(getNav("employee")).not.toEqual(getNav("admin"));
  });

  it("falls back to the employee menu for an unknown role", () => {
    expect(getNav("something-else")).toEqual(getNav("employee"));
  });
});

describe("activeHref", () => {
  const emp = getNav("employee");
  const admin = getNav("admin");

  it("selects the section root on the root path itself", () => {
    expect(activeHref(emp, "/employee")).toBe("/employee");
    expect(activeHref(admin, "/admin")).toBe("/admin");
  });

  it("selects the child, NOT the section root, on a child path", () => {
    expect(activeHref(emp, "/employee/history")).toBe("/employee/history");
    expect(activeHref(admin, "/admin/reports")).toBe("/admin/reports");
  });

  it("keeps the child selected on a deeper nested path", () => {
    expect(activeHref(admin, "/admin/sites/123/edit")).toBe("/admin/sites");
  });

  it("does not match a sibling that merely shares a name prefix", () => {
    // "/admin/site-groups" must not select "/admin/sites".
    expect(activeHref(admin, "/admin/site-groups")).toBe("/admin");
  });

  it("returns null when nothing matches", () => {
    expect(activeHref(emp, "/admin")).toBeNull();
  });

  it("never reports more than one active item", () => {
    for (const path of [
      "/employee",
      "/employee/history",
      "/admin",
      "/admin/sites",
      "/admin/schedules",
    ]) {
      const nav = path.startsWith("/admin") ? admin : emp;
      const active = activeHref(nav, path);
      const count = nav.filter((i) => i.href === active).length;
      expect(count).toBe(1);
    }
  });
});
