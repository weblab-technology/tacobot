import type { Metadata } from "next";
import { config } from "@/lib/config";
import { db } from "@/lib/db/client";
import { listActiveItems } from "@/lib/db/queries";

export const runtime = "nodejs";
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Shop",
};

export default async function ShopPage() {
  const items = await listActiveItems(db);

  const hrId = config.hr.slackId;
  const hrHandle = config.hr.slackHandle;
  const hrLabel = hrHandle ? `@${hrHandle}` : "HR";
  const hrContact = hrId ? (
    <a
      href={`https://slack.com/app_redirect?channel=${hrId}`}
      className="font-medium text-amber-700 hover:underline"
    >
      {hrLabel}
    </a>
  ) : (
    hrLabel
  );

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-bold">🌮 Tacobot Shop</h1>
        <p className="mt-2 text-gray-600">
          Earn tacos by being recognized in <code>#taqueria</code>. To redeem an item, DM {hrContact} with the item name.
          Check your balance by DMing <code>@tacobot</code> the word <code>balance</code>.
        </p>
      </header>

      {items.length === 0 ? (
        <p className="text-gray-500">No items available right now. Check back later.</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2">
          {items.map((it: typeof items[number]) => (
            <li key={it.id} className="rounded-lg border border-gray-200 p-4">
              {it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.imageUrl} alt="" className="mb-3 h-40 w-full rounded object-cover" />
              ) : null}
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-semibold">{it.name}</h2>
                <span className="whitespace-nowrap rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
                  {it.priceTacos} 🌮
                </span>
              </div>
              {it.description ? (
                <p className="mt-2 text-sm text-gray-600">{it.description}</p>
              ) : null}
              {it.quantity !== null ? (
                <p className="mt-2 text-xs text-gray-500">
                  {it.quantity} available
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
