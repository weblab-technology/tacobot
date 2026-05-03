import Image from "next/image";
import { db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import { desc } from "drizzle-orm";
import { createItem, toggleItemActive, updateItem } from "./actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fieldLabel = "block text-xs font-medium text-gray-700 mb-1";
const fieldInput = "w-full rounded border border-gray-300 px-3 py-2";

function ItemFormFields({
  defaults,
}: {
  defaults?: {
    name: string;
    description: string | null;
    priceTacos: number;
    quantity: number | null;
    redemptionInstructions: string | null;
    imageUrl: string | null;
  };
}) {
  return (
    <>
      <div>
        <label className={fieldLabel}>Title</label>
        <input
          name="name"
          required
          defaultValue={defaults?.name ?? ""}
          className={fieldInput}
        />
      </div>
      <div>
        <label className={fieldLabel}>Redemption amount (tacos)</label>
        <input
          name="price_tacos"
          type="number"
          min={1}
          required
          defaultValue={defaults?.priceTacos ?? ""}
          className={fieldInput}
        />
      </div>
      <div>
        <label className={fieldLabel}>Quantity (optional)</label>
        <input
          name="quantity"
          type="number"
          min={1}
          defaultValue={defaults?.quantity ?? ""}
          placeholder="Leave empty for unlimited"
          className={fieldInput}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={fieldLabel}>Description</label>
        <textarea
          name="description"
          rows={2}
          defaultValue={defaults?.description ?? ""}
          className={fieldInput}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={fieldLabel}>Redemption instructions (optional)</label>
        <textarea
          name="redemption_instructions"
          rows={2}
          defaultValue={defaults?.redemptionInstructions ?? ""}
          placeholder="Shown to admins when redeeming, e.g. 'DM kitchen Slack'"
          className={fieldInput}
        />
      </div>
      <div className="sm:col-span-2">
        <label className={fieldLabel}>Image — upload a file…</label>
        <input
          name="image_file"
          type="file"
          accept="image/*"
          className={fieldInput}
        />
        <p className="mt-1 text-xs text-gray-500">
          …or paste a URL below. Uploaded file wins if both are set.
        </p>
        <input
          name="image_url"
          defaultValue={defaults?.imageUrl ?? ""}
          placeholder="https://…"
          className={`${fieldInput} mt-1`}
        />
        {defaults?.imageUrl ? (
          <div className="mt-2">
            <Image
              src={defaults.imageUrl}
              alt={defaults.name}
              width={120}
              height={120}
              className="rounded border border-gray-200 object-cover"
              unoptimized
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

export default async function ItemsPage() {
  const all = await db
    .select()
    .from(items)
    .orderBy(desc(items.isActive), desc(items.updatedAt));

  return (
    <div className="space-y-8">
      <section>
        <h1 className="mb-4 text-2xl font-bold">Items catalog</h1>
        <form
          action={createItem}
          encType="multipart/form-data"
          className="grid gap-4 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-2"
        >
          <ItemFormFields />
          <button
            type="submit"
            className="rounded bg-amber-500 px-4 py-2 text-white hover:bg-amber-600 sm:col-span-2"
          >
            Add item
          </button>
        </form>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">All items</h2>
        <ul className="space-y-3">
          {all.map((it) => (
            <li
              key={it.id}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <form
                action={async (form) => {
                  "use server";
                  await updateItem(it.id, form);
                }}
                encType="multipart/form-data"
                className="grid gap-4 sm:grid-cols-2"
              >
                <ItemFormFields
                  defaults={{
                    name: it.name,
                    description: it.description,
                    priceTacos: it.priceTacos,
                    quantity: it.quantity,
                    redemptionInstructions: it.redemptionInstructions,
                    imageUrl: it.imageUrl,
                  }}
                />
                <div className="flex items-center justify-between sm:col-span-2">
                  <span
                    className={`text-sm ${it.isActive ? "text-emerald-700" : "text-gray-500"}`}
                  >
                    {it.isActive ? "Active" : "Inactive"}
                  </span>
                  <button
                    type="submit"
                    className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-100"
                  >
                    Save
                  </button>
                </div>
              </form>
              <form
                action={async () => {
                  "use server";
                  await toggleItemActive(it.id, !it.isActive);
                }}
                className="mt-2"
              >
                <button
                  type="submit"
                  className="text-sm text-gray-600 underline hover:text-gray-900"
                >
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
