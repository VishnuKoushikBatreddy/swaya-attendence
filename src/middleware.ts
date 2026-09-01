/**
 * NextAuth middleware — protects dashboard routes and enforces role-prefix rules.
 */
import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

const ROLE_PREFIXES: { prefix: string; allow: string[] }[] = [
  // Each role owns exactly one area. The per-area layouts enforce the same rule
  // server-side; these two must agree or the middleware lets a request through
  // only for the layout to bounce it.
  { prefix: "/admin", allow: ["admin"] },
  { prefix: "/employee", allow: ["employee"] },
];

const PUBLIC_AUTH_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password"];

function roleHome(role: string): string {
  return role === "admin" ? "/admin" : "/employee";
}

function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export default withAuth(
  function middleware(req) {
    const token = req.nextauth.token;
    const { pathname } = req.nextUrl;

    // Public auth pages — let them through. If already signed in, send to role home.
    if (isPublicAuthPath(pathname)) {
      if (token) {
        return NextResponse.redirect(new URL(roleHome(token.role as string), req.url));
      }
      return NextResponse.next();
    }

    if (!token) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(loginUrl);
    }

    const role = token.role as string;

    // If user hits "/" while already signed in, send to their home.
    if (pathname === "/") {
      return NextResponse.redirect(new URL(roleHome(role), req.url));
    }

    // Role-prefix enforcement
    for (const rule of ROLE_PREFIXES) {
      if (pathname === rule.prefix || pathname.startsWith(rule.prefix + "/")) {
        if (!rule.allow.includes(role)) {
          return NextResponse.redirect(new URL(roleHome(role), req.url));
        }
      }
    }

    return NextResponse.next();
  },
  {
    callbacks: {
      // We do the redirect manually in the middleware fn above.
      authorized: () => true,
    },
  }
);

export const config = {
  matcher: [
    "/",
    "/login",
    "/signup",
    "/forgot-password",
    "/reset-password",
    "/admin/:path*",
    "/employee/:path*",
  ],
};
