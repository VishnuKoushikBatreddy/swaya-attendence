import "next-auth";
import "next-auth/jwt";
// Type-only, and from a dependency-free module: importing api-helpers here
// would be circular, since it imports next-auth and so depends on this
// augmentation.
import type { Role } from "@/lib/roles";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      // Typed as the union, not `string`: a plain string meant a comparison
      // against a role that no longer exists (`=== "manager"`) still compiled,
      // which is exactly how stale role checks survived unnoticed.
      role: Role;
      companyId: string;
    };
  }

  interface User {
    id: string;
    role: Role;
    companyId: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    companyId: string;
  }
}
