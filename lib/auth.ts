import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { getActiveWorkspace } from "@/lib/active-workspace";
import {
  ensureWorkspaceForUser,
  hasPendingWorkspaceInvitation,
} from "@/lib/workspace";
import { isAuthSignInAllowed } from "@/lib/auth-allowlist";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

export const authConfig = {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
      from: process.env.EMAIL_FROM ?? "OpenReply <login@example.com>",
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? "missing-google-client-id",
      clientSecret:
        process.env.GOOGLE_CLIENT_SECRET ?? "missing-google-client-secret",
      // Safe here: the domain/email allowlist below gates who can arrive, and
      // magic-link users have no Account row, so without this flag their first
      // Google sign-in would dead-end on OAuthAccountNotLinked.
      allowDangerousEmailAccountLinking: true,
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // A Google account whose email Google itself has not verified never
      // passes, whatever the allowlists say.
      if (account?.provider === "google" && profile?.email_verified !== true) {
        return false;
      }

      const allowlisted = isAuthSignInAllowed(
        user.email,
        process.env.AUTH_ALLOWED_EMAILS,
        process.env.AUTH_ALLOWED_DOMAINS,
      );
      if (allowlisted) return true;

      // Reviewer and partner access is granted by an exact, expiring
      // workspace invitation. This avoids broadening the global domain list.
      return hasPendingWorkspaceInvitation(user.email);
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
    async signIn({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
    // A denied sign-in (domain not allowed, unverified Google email) comes
    // back to the styled login page with ?error=AccessDenied instead of the
    // bare NextAuth error page.
    error: "/login",
  },
  session: {
    strategy: "database",
  },
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const active = await getActiveWorkspace(userId);
  if (active) return active.workspace.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  await ensureWorkspaceForUser(userId, user?.email);
  const reconciled = await getActiveWorkspace(userId);
  return reconciled?.workspace.id ?? null;
}
