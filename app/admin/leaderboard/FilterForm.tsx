"use client";

import Link from "next/link";
import { useRef } from "react";
import type { LeaderboardMetric } from "@/lib/db/queries";
import type { LeaderboardPeriod } from "@/lib/date";

type Props = {
  metric: LeaderboardMetric;
  period: LeaderboardPeriod;
  channel: string | null;
  metricOptions: ReadonlyArray<{ value: LeaderboardMetric; label: string }>;
  periodOptions: ReadonlyArray<{ value: LeaderboardPeriod; label: string }>;
  channels: ReadonlyArray<{ id: string; name: string | null }>;
};

export default function FilterForm({
  metric,
  period,
  channel,
  metricOptions,
  periodOptions,
  channels,
}: Props) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => formRef.current?.requestSubmit();
  const showClear = metric !== "received" || period !== "all" || channel;
  // Redeemable reads the live balance — period/channel windows don't apply.
  const periodChannelDisabled = metric === "redeemable";

  return (
    <form
      ref={formRef}
      method="get"
      action="/admin/leaderboard"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <label className="sr-only" htmlFor="metric">Metric</label>
      <select
        id="metric"
        name="metric"
        defaultValue={metric}
        onChange={submit}
        className="rounded border border-gray-300 px-2 py-1"
      >
        {metricOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="period">Period</label>
      <select
        id="period"
        name="period"
        defaultValue={period}
        onChange={submit}
        disabled={periodChannelDisabled}
        className="rounded border border-gray-300 px-2 py-1 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
      >
        {periodOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="channel">Channel</label>
      <select
        id="channel"
        name="channel"
        defaultValue={channel ?? ""}
        onChange={submit}
        disabled={periodChannelDisabled}
        className="rounded border border-gray-300 px-2 py-1 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-400"
      >
        <option value="">All channels</option>
        {channels.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name ? `#${c.name}` : c.id}
          </option>
        ))}
      </select>

      <noscript>
        <button type="submit" className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-100">
          Apply
        </button>
      </noscript>

      {showClear ? (
        <Link href="/admin/leaderboard" className="text-gray-500 hover:text-gray-700 underline">
          clear
        </Link>
      ) : null}
    </form>
  );
}
