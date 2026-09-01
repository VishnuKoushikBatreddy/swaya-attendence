/**
 * NextAuth configuration — credentials provider with JWT sessions.
 * Augments session.user with role + companyId (see src/types/next-auth.d.ts).
 */
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { connectDB } from "./db";
import { isRole, type Role } from "./roles";
import { User } from "@/models";

/**
 * Coerce an untrusted value to a Role, defaulting to the least privileged one.
 * Session and JWT roles originate in the database, so they are outside the type
 * system until checked here.
 */
function toRole(value: unknown): Role {
  return isRole(value) ? value : "employee";
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 }, // 7 days
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        await connectDB();
        const user = await User.findOne({
          email: credentials.email.toLowerCase().trim(),
        }).select("+passwordHash");
        if (!user || !user.isActive) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        return {
          id: String(user._id),
          name: user.fullName,
          email: user.email,
          role: user.role,
          companyId: String(user.companyId),
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as { id: string }).id;
        // Narrow rather than cast: the role comes from a database document, so
        // a legacy or hand-edited value could be anything. Falling back to the
        // least-privileged role means an unrecognised value can never be
        // mistaken for an admin.
        token.role = toRole((user as { role?: unknown }).role);
        token.companyId = (user as { companyId: string }).companyId;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? "";
        session.user.role = toRole(token.role);
        session.user.companyId = (token.companyId as string) ?? "";
      }
      return session;
    },
  },
  secret: process.env.NEXTAUTH_SECRET,
};
