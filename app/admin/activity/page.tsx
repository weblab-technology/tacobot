import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { transactions, users } from "@/lib/db/schema";
import { resolveChannelName } from "@/lib/slack/channelInfo";
import { resolveUserName } from "@/lib/slack/userInfo";
import { formatDayHeading, formatTimeOfDay, localDayKey } from "@/lib/date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Activity",
};

const PAGE_SIZE = 50;
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g;
const SLACK_LINK = (id: string) => `https://slack.com/app_redirect?channel=${id}`;

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

  // Collect every user id we'll need a name for: givers, recipients, and any
  // <@USERID> mention inside a body.
  const userIds = new Set<string>();
  for (const e of visibleEvents) {
    if (e.fromUserId) userIds.add(e.fromUserId);
    for (const rid of e.recipientIds) userIds.add(rid);
    if (e.reason) for (const m of e.reason.matchAll(MENTION_RE)) userIds.add(m[1]);
  }
  const userRows = userIds.size
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...userIds]))
    : [];
  const nameById = new Map<string, string>(userRows.map((u) => [u.id, u.name]));

  // For ids the local users table doesn't know about (mentioned but never
  // received a give, or never been resolved yet), ask Slack. Cheap on warm
  // cache; bounded by ~PAGE_SIZE distinct ids on a cold one.
  const missingIds = [...userIds].filter((id) => !nameById.has(id) || nameById.get(id) === id);
  if (missingIds.length) {
    const resolved = await Promise.all(missingIds.map((id) => resolveUserName(id)));
    for (let i = 0; i < missingIds.length; i++) {
      const name = resolved[i];
      if (name) nameById.set(missingIds[i], name);
    }
  }

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
  const giverName = displayName(event.fromUserId, nameById);
  const isReaction = event.slackEventId.startsWith("react-");
  const perRecipient = event.recipientCount > 0 ? Math.round(event.totalAmount / event.recipientCount) : event.totalAmount;
  const tacoWord = perRecipient === 1 ? "taco" : "tacos";
  const channelName = event.slackChannelId ? channelLabelById.get(event.slackChannelId) : null;
  const showBody = event.reason && event.reason !== "reaction";

  return (
    <div className="flex gap-3 rounded-lg border border-gray-200 bg-white p-3">
      <Avatar name={giverName} />
      <div className="min-w-0 flex-1">
        <div className="text-sm">
          <UserMention id={event.fromUserId} nameById={nameById} bold />
          <span className="text-gray-700">
            {" "}gave {perRecipient} {tacoWord}
            {isReaction ? " reaction" : ""} to{" "}
          </span>
          <RecipientList ids={event.recipientIds} nameById={nameById} />
          <span className="text-gray-700"> in </span>
          <ChannelMention id={event.slackChannelId} name={channelName ?? null} />
          <span className="text-gray-400"> {formatTimeOfDay(ts)}</span>
        </div>
        {showBody ? (
          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700">
            <BodyText text={event.reason!} nameById={nameById} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function UserMention({
  id,
  nameById,
  bold = false,
}: {
  id: string | null;
  nameById: Map<string, string>;
  bold?: boolean;
}) {
  if (!id) return <span className="text-gray-500">(unknown)</span>;
  const name = displayName(id, nameById);
  const cls = `text-amber-700 hover:underline ${bold ? "font-semibold" : ""}`.trim();
  return (
    <a href={SLACK_LINK(id)} className={cls} target="_blank" rel="noreferrer">
      {name}
    </a>
  );
}

function RecipientList({ ids, nameById }: { ids: string[]; nameById: Map<string, string> }) {
  if (ids.length === 0) return <span className="text-gray-500">(no one)</span>;
  return (
    <>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i > 0 ? <span className="text-gray-700">{i === ids.length - 1 ? " and " : ", "}</span> : null}
          <UserMention id={id} nameById={nameById} />
        </Fragment>
      ))}
    </>
  );
}

function ChannelMention({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-gray-500">(no channel)</span>;
  return (
    <a
      href={SLACK_LINK(id)}
      className="text-amber-700 hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      #{name ?? id}
    </a>
  );
}

function BodyText({ text, nameById }: { text: string; nameById: Map<string, string> }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > cursor) parts.push(text.slice(cursor, start));
    const id = m[1];
    const name = displayName(id, nameById);
    parts.push(
      <a
        key={key++}
        href={SLACK_LINK(id)}
        className="font-medium text-amber-700 hover:underline"
        target="_blank"
        rel="noreferrer"
      >
        @{name}
      </a>,
    );
    cursor = start + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

function displayName(id: string | null, nameById: Map<string, string>): string {
  if (!id) return "(unknown)";
  const n = nameById.get(id);
  return n && n !== id ? n : id;
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
