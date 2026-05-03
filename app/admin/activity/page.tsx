import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { transactions, users } from "@/lib/db/schema";
import { resolveChannelName } from "@/lib/slack/channelInfo";
import { formatDayHeading, formatTimeOfDay, localDayKey } from "@/lib/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity",
};

const PAGE_SIZE = 50;

type SearchParams = Promise<{
  channel?: string;
  before?: string;
}>;

export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const { channel: channelFilter, before } = await searchParams;
  const beforeDate = before ? new Date(before) : null;
  const validBefore = beforeDate && !isNaN(beforeDate.getTime()) ? beforeDate : null;

  const conditions = [
    eq(transactions.type, "give"),
    ...(channelFilter ? [eq(transactions.slackChannelId, channelFilter)] : []),
    ...(validBefore ? [lt(transactions.createdAt, validBefore)] : []),
  ];

  // Fire the three queries in parallel: page rows, all-time total, channel options.
  const [giveEvents, totalRow, channelIdRows] = await Promise.all([
    db
      .select({
        fromUserId: transactions.fromUserId,
        slackChannelId: transactions.slackChannelId,
        slackMessageTs: transactions.slackMessageTs,
        slackEventId: sql<string>`min(${transactions.slackEventId})`,
        reason: sql<string | null>`min(${transactions.reason})`,
        totalAmount: sql<number>`sum(${transactions.amount})::int`,
        recipientCount: sql<number>`count(*)::int`,
        createdAt: sql<string>`min(${transactions.createdAt})`,
        recipientIds: sql<string[]>`array_agg(${transactions.toUserId} order by ${transactions.toUserId})`,
      })
      .from(transactions)
      .where(and(...conditions))
      .groupBy(transactions.fromUserId, transactions.slackChannelId, transactions.slackMessageTs)
      .orderBy(desc(sql`min(${transactions.createdAt})`))
      .limit(PAGE_SIZE + 1),
    db
      .select({ total: sql<number>`coalesce(sum(${transactions.amount}), 0)::int` })
      .from(transactions)
      .where(eq(transactions.type, "give")),
    db
      .selectDistinct({ id: transactions.slackChannelId })
      .from(transactions)
      .where(and(eq(transactions.type, "give"), isNotNull(transactions.slackChannelId))),
  ]);

  const hasMore = giveEvents.length > PAGE_SIZE;
  const visibleEvents = hasMore ? giveEvents.slice(0, PAGE_SIZE) : giveEvents;

  // Batch-resolve display names for every user that shows up on this page.
  const userIds = new Set<string>();
  for (const e of visibleEvents) {
    if (e.fromUserId) userIds.add(e.fromUserId);
    for (const rid of e.recipientIds) userIds.add(rid);
  }
  const userRows = userIds.size
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds]))
    : [];
  const nameById = new Map(userRows.map((u) => [u.id, u.name]));

  // Resolve channel names for the filter dropdown plus any channel that shows
  // up in the visible page (typically a small overlap).
  const channelIdsToLabel = new Set<string>();
  for (const r of channelIdRows) if (r.id) channelIdsToLabel.add(r.id);
  for (const e of visibleEvents) if (e.slackChannelId) channelIdsToLabel.add(e.slackChannelId);
  const labeledChannels = await Promise.all(
    [...channelIdsToLabel].map(async (id) => ({ id, name: await resolveChannelName(id) })),
  );
  const channelLabelById = new Map(labeledChannels.map((c) => [c.id, c.name]));
  const filterOptions = labeledChannels
    .filter((c) => channelIdRows.some((r) => r.id === c.id))
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));

  const allTimeTotal = totalRow[0]?.total ?? 0;
  const totalLabel = new Intl.NumberFormat("en-US").format(allTimeTotal);

  const lastVisible = visibleEvents[visibleEvents.length - 1];
  const nextBefore = hasMore && lastVisible ? new Date(lastVisible.createdAt).toISOString() : null;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">Activity</h1>
      </div>

      <div className="rounded-lg bg-white p-4 shadow-sm">
        <div className="text-xs uppercase tracking-wide text-gray-500">All-time tacos given</div>
        <div className="mt-1 text-3xl font-semibold">🌮 {totalLabel}</div>
      </div>

      <form method="get" action="/admin/activity" className="flex items-center gap-2 text-sm">
        <label htmlFor="channel" className="text-gray-600">Filter:</label>
        <select
          id="channel"
          name="channel"
          defaultValue={channelFilter ?? ""}
          className="rounded border border-gray-300 px-2 py-1"
        >
          <option value="">All channels</option>
          {filterOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ? `#${c.name}` : c.id}
            </option>
          ))}
        </select>
        <button type="submit" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-100">
          Apply
        </button>
        {channelFilter ? (
          <Link href="/admin/activity" className="text-gray-500 hover:text-gray-700 underline">
            clear
          </Link>
        ) : null}
      </form>

      {visibleEvents.length === 0 ? (
        <p className="text-gray-500">
          {channelFilter ? "No tacos have been given in this channel yet." : "No tacos have been given yet."}
        </p>
      ) : (
        <ActivityList
          events={visibleEvents}
          nameById={nameById}
          channelLabelById={channelLabelById}
        />
      )}

      {nextBefore ? (
        <div className="pt-2">
          <Link
            href={{
              pathname: "/admin/activity",
              query: {
                ...(channelFilter ? { channel: channelFilter } : {}),
                before: nextBefore,
              },
            }}
            className="text-sm text-blue-600 hover:underline"
          >
            Load older →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

type GiveEventRow = {
  fromUserId: string | null;
  slackChannelId: string | null;
  slackEventId: string;
  reason: string | null;
  totalAmount: number;
  recipientCount: number;
  createdAt: string;
  recipientIds: string[];
};

function ActivityList({
  events,
  nameById,
  channelLabelById,
}: {
  events: GiveEventRow[];
  nameById: Map<string, string>;
  channelLabelById: Map<string, string | null>;
}) {
  const out: React.ReactNode[] = [];
  let lastDayKey: string | null = null;
  for (const e of events) {
    const ts = new Date(e.createdAt);
    const dayKey = localDayKey(ts);
    if (dayKey !== lastDayKey) {
      out.push(
        <h2 key={`day-${dayKey}`} className="pt-4 text-sm font-semibold text-gray-700">
          {formatDayHeading(ts)}
        </h2>,
      );
      lastDayKey = dayKey;
    }
    out.push(<ActivityRow key={e.slackEventId} event={e} nameById={nameById} channelLabelById={channelLabelById} />);
  }
  return <div className="space-y-3">{out}</div>;
}

function ActivityRow({
  event,
  nameById,
  channelLabelById,
}: {
  event: GiveEventRow;
  nameById: Map<string, string>;
  channelLabelById: Map<string, string | null>;
}) {
  const ts = new Date(event.createdAt);
  const giverName = event.fromUserId ? nameById.get(event.fromUserId) ?? event.fromUserId : "(unknown)";
  const recipientNames = event.recipientIds.map((id) => nameById.get(id) ?? id);
  const isReaction = event.slackEventId.startsWith("react-");
  const perRecipient = event.recipientCount > 0 ? Math.round(event.totalAmount / event.recipientCount) : event.totalAmount;
  const tacoWord = perRecipient === 1 ? "taco" : "tacos";
  const channelName = event.slackChannelId ? channelLabelById.get(event.slackChannelId) : null;
  const channelLabel = channelName ? `#${channelName}` : event.slackChannelId ?? "(no channel)";
  const showBody = event.reason && event.reason !== "reaction";

  return (
    <div className="flex gap-3 rounded-lg border border-gray-200 bg-white p-3">
      <Avatar name={giverName} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <span className="font-medium">{giverName}</span>{" "}
          <span className="text-gray-700">
            gave {perRecipient} {tacoWord}
            {isReaction ? " reaction" : ""} to {joinNames(recipientNames)} in {channelLabel}
          </span>{" "}
          <span className="text-gray-400">{formatTimeOfDay(ts)}</span>
        </div>
        {showBody ? (
          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700">{event.reason}</div>
        ) : null}
      </div>
    </div>
  );
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

function joinNames(names: string[]): string {
  if (names.length === 0) return "(no one)";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
