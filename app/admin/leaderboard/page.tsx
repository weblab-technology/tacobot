import type { Metadata } from "next";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { getLeaderboard, type LeaderboardMetric } from "@/lib/db/queries";
import { transactions, users } from "@/lib/db/schema";
import { resolveChannelName } from "@/lib/slack/channelInfo";
import { resolveUserName } from "@/lib/slack/userInfo";
import { periodStart, type LeaderboardPeriod } from "@/lib/date";
import FilterForm from "./FilterForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
};

const SLACK_LINK = (id: string) => `https://slack.com/app_redirect?channel=${id}`;

const METRIC_OPTIONS: { value: LeaderboardMetric; label: string }[] = [
  { value: "received", label: "Tacos received" },
  { value: "given", label: "Tacos given" },
  { value: "combined", label: "Tacos combined" },
];

const PERIOD_OPTIONS: { value: LeaderboardPeriod; label: string }[] = [
  { value: "all", label: "All-time" },
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

type SearchParams = Promise<{
  metric?: string;
  period?: string;
  channel?: string;
}>;

function parseMetric(v: string | undefined): LeaderboardMetric {
  return v === "given" || v === "combined" ? v : "received";
}

function parsePeriod(v: string | undefined): LeaderboardPeriod {
  return v === "today" || v === "week" || v === "month" ? v : "all";
}

export default async function LeaderboardPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const metric = parseMetric(sp.metric);
  const period = parsePeriod(sp.period);
  const channel = sp.channel?.trim() || null;
  const since = periodStart(period, new Date());

  const [rows, channelIdRows] = await Promise.all([
    getLeaderboard(db, { metric, since, channel }),
    db
      .selectDistinct({ id: transactions.slackChannelId })
      .from(transactions)
      .where(and(eq(transactions.type, "give"), isNotNull(transactions.slackChannelId))),
  ]);

  // Resolve user names for the visible rows.
  const userIds = rows.map((r) => r.userId);
  const userRows = userIds.length
    ? await db
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const nameById = new Map(userRows.map((u) => [u.id, u.name]));
  const missing = userIds.filter((id) => !nameById.has(id) || nameById.get(id) === id);
  if (missing.length) {
    const resolved = await Promise.all(missing.map((id) => resolveUserName(id)));
    for (let i = 0; i < missing.length; i++) {
      const name = resolved[i];
      if (name) nameById.set(missing[i], name);
    }
  }

  // Resolve channel labels for the dropdown.
  const channelIds = channelIdRows.map((r) => r.id).filter((x): x is string => !!x);
  const labeledChannels = await Promise.all(
    channelIds.map(async (id) => ({ id, name: await resolveChannelName(id) })),
  );
  labeledChannels.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const ranked = withRanks(rows);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Leaderboard</h1>

      <FilterForm
        metric={metric}
        period={period}
        channel={channel}
        metricOptions={METRIC_OPTIONS}
        periodOptions={PERIOD_OPTIONS}
        channels={labeledChannels}
      />

      {ranked.length === 0 ? (
        <p className="text-gray-500">No tacos in this view.</p>
      ) : (
        <table className="w-full divide-y divide-gray-200 rounded-lg bg-white">
          <thead className="text-left text-sm text-gray-600">
            <tr>
              <th className="px-4 py-3 w-16">Rank</th>
              <th className="px-4 py-3">Person</th>
              <th className="px-4 py-3 w-40">Total Tacos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 text-sm">
            {ranked.map((r) => {
              const name = nameById.get(r.userId) ?? r.userId;
              return (
                <tr key={r.userId}>
                  <td className="px-4 py-3 text-gray-500">{r.rank}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Avatar name={name} />
                      <a
                        href={SLACK_LINK(r.userId)}
                        target="_blank"
                        rel="noreferrer"
                        className="font-medium text-amber-700 hover:underline"
                      >
                        {name}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-semibold">🌮 {r.total}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function withRanks(rows: { userId: string; total: number }[]) {
  // Sport ranking: ties share rank, next rank skips by group size.
  const out: { userId: string; total: number; rank: number }[] = [];
  let lastTotal: number | null = null;
  let lastRank = 0;
  rows.forEach((row, i) => {
    const rank = lastTotal === row.total ? lastRank : i + 1;
    out.push({ ...row, rank });
    lastTotal = row.total;
    lastRank = rank;
  });
  return out;
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <div className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-amber-100 text-xs font-semibold text-amber-800">
      {initials || "?"}
    </div>
  );
}
