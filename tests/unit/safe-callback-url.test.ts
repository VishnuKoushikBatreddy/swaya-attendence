/**
 * Post-login redirect target.
 *
 * `callbackUrl` arrives on the query string and is handed to router.push(),
 * which performs a full navigation for an absolute URL. Unfiltered, that let
 * /login?callbackUrl=https://evil.example send a freshly authenticated user
 * straight to an attacker's page — a textbook open redirect, and a good phishing
 * primitive because the victim has just proved the login screen was genuine.
 *
 * The middleware only ever sets this to a pathname, so anything else is either a
 * mistake or an attack.
 */
import { describe, it, expect } from "vitest";
import { safeCallbackUrl } from "@/components/auth/LoginForm";

describe("safeCallbackUrl", () => {
  it("keeps an in-app path", () => {
    expect(safeCallbackUrl("/admin/live")).toBe("/admin/live");
    expect(safeCallbackUrl("/employee")).toBe("/employee");
  });

  it("keeps a path with a query string and hash", () => {
    expect(safeCallbackUrl("/admin/reports?from=2026-01-01#top")).toBe(
      "/admin/reports?from=2026-01-01#top"
    );
  });

  it("defaults to the root when absent", () => {
    expect(safeCallbackUrl(null)).toBe("/");
    expect(safeCallbackUrl(undefined)).toBe("/");
    expect(safeCallbackUrl("")).toBe("/");
  });

  it("rejects an absolute URL", () => {
    expect(safeCallbackUrl("https://evil.example/login")).toBe("/");
    expect(safeCallbackUrl("http://evil.example")).toBe("/");
  });

  it("rejects a protocol-relative URL", () => {
    // Starts with "/" but navigates off-site all the same.
    expect(safeCallbackUrl("//evil.example")).toBe("/");
    expect(safeCallbackUrl("//evil.example/path")).toBe("/");
  });

  it("rejects a backslash-prefixed URL", () => {
    // Some browsers normalise "\" to "/", making this protocol-relative.
    expect(safeCallbackUrl("/\\evil.example")).toBe("/");
  });

  it("rejects a javascript: payload", () => {
    expect(safeCallbackUrl("javascript:alert(1)")).toBe("/");
  });

  it("rejects anything not starting with a slash", () => {
    expect(safeCallbackUrl("evil.example")).toBe("/");
    expect(safeCallbackUrl("admin")).toBe("/");
  });
});
