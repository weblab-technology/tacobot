import NextAuth from "next-auth";
import Slack from "next-auth/providers/slack";
import { config as appConfig } from "@/lib/config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Slack({
      clientId: appConfig.slack.clientId,
      clientSecret: appConfig.slack.clientSecret,
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ profile }) {
      const slackUserId = pickSlackUserId(profile);
      if (!slackUserId) return false;
      return appConfig.admin.slackIds.includes(slackUserId);
    },
    async jwt({ token, profile }) {
      if (profile) {
        const slackUserId = pickSlackUserId(profile);
        if (slackUserId) token.slackUserId = slackUserId;
      }
      return token;
    },
    async session({ session, token }) {
      if (typeof token.slackUserId === "string") {
        (session as { slackUserId?: string }).slackUserId = token.slackUserId;
      }
      return session;
    },
  },
});

function pickSlackUserId(profile: unknown): string | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  const fromTeam = p["https://slack.com/user_id"];
  if (typeof fromTeam === "string") return fromTeam;
  if (typeof p.sub === "string") return p.sub;
  return undefined;
}
