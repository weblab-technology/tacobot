import { db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { createItem, toggleItemActive, updateItem } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ItemsPage() {
  const all = await db.select().from(items).orderBy(desc(items.isActive), desc(items.updatedAt));

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-2xl font-bold">Items catalog</h1>
        <form action={createItem} className="grid gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2">
          <input name="name" placeholder="Name" required className="rounded border border-gray-300 px-3 py-2" />
          <input name="price_tacos" type="number" min={1} placeholder="Price (tacos)" required className="rounded border border-gray-300 px-3 py-2" />
          <input name="image_url" placeholder="Image URL (optional)" className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
          <textarea name="description" placeholder="Description (optional)" rows={2} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
          <button type="submit" className="rounded bg-amber-500 px-4 py-2 text-white hover:bg-amber-600 sm:col-span-2">
            Add item
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">All items</h2>
        <ul className="space-y-3">
          {all.map((it) => (
            <li key={it.id} className="rounded-lg border border-gray-200 bg-white p-4">
              <form
                action={async (form) => {
                  "use server";
                  await updateItem(it.id, form);
                }}
                className="grid gap-3 sm:grid-cols-2"
              >
                <input name="name" defaultValue={it.name} required className="rounded border border-gray-300 px-3 py-2" />
                <input name="price_tacos" type="number" min={1} defaultValue={it.priceTacos} required className="rounded border border-gray-300 px-3 py-2" />
                <input name="image_url" defaultValue={it.imageUrl ?? ""} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
                <textarea name="description" defaultValue={it.description ?? ""} rows={2} className="rounded border border-gray-300 px-3 py-2 sm:col-span-2" />
                <div className="flex items-center justify-between sm:col-span-2">
                  <span className={`text-sm ${it.isActive ? "text-emerald-700" : "text-gray-500"}`}>
                    {it.isActive ? "Active" : "Inactive"}
                  </span>
                  <div className="flex gap-2">
                    <button type="submit" className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100">
                      Save
                    </button>
                  </div>
                </div>
              </form>
              <form
                action={async () => {
                  "use server";
                  await toggleItemActive(it.id, !it.isActive);
                }}
                className="mt-2"
              >
                <button type="submit" className="text-sm text-gray-600 underline hover:text-gray-900">
                  {it.isActive ? "Deactivate" : "Reactivate"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
