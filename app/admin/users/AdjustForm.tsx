"use client";

import { adjustTacos } from "./actions";

export function AdjustForm({ userId, userName }: { userId: string; userName: string }) {
  return (
    <form
      action={adjustTacos}
      onSubmit={(e) => {
        const form = e.currentTarget;
        const amountStr =
          (form.elements.namedItem("amount") as HTMLInputElement | null)?.value ?? "";
        const reason =
          ((form.elements.namedItem("reason") as HTMLInputElement | null)?.value ?? "").trim();
        const n = Number.parseInt(amountStr, 10);
        // Let the browser's `required` + the server validator handle invalid input.
        if (!Number.isFinite(n) || n === 0) return;

        const sign = n > 0 ? "+" : "";
        const lines = [
          `Apply ${sign}${n} taco${Math.abs(n) === 1 ? "" : "s"} to ${userName}?`,
          reason ? `Reason: ${reason}` : null,
          n < 0 ? "\nThis will DECREASE the user's balance." : null,
        ].filter((l): l is string => l !== null);

        if (!window.confirm(lines.join("\n"))) e.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="recipient_id" value={userId} />
      <input
        name="amount"
        type="number"
        step={1}
        placeholder="±N"
        required
        className="w-24 rounded border border-gray-300 px-2 py-1"
      />
      <input
        name="reason"
        placeholder="reason (e.g. onboarding)"
        className="flex-1 rounded border border-gray-300 px-2 py-1"
      />
      <button
        type="submit"
        className="rounded bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-700"
      >
        Adjust
      </button>
    </form>
  );
}
