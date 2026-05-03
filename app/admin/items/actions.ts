"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
import { put } from "@vercel/blob";
import { db } from "@/lib/db/client";
import { items } from "@/lib/db/schema";
import { auth } from "@/lib/auth";

async function requireAdmin() {
  const s = await auth();
  if (!s) throw new Error("unauthorized");
  return s;
}

function intField(form: FormData, key: string): number {
  const raw = form.get(key);
  if (typeof raw !== "string") throw new Error(`${key} required`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer`);
  return n;
}

function optionalIntField(form: FormData, key: string): number | null {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive integer if set`);
  return n;
}

function textField(form: FormData, key: string, opts: { required?: boolean } = {}): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim() === "") {
    if (opts.required) throw new Error(`${key} required`);
    return null;
  }
  return raw.trim();
}

/**
 * Resolve the image URL from the form. Order of precedence:
 * 1. Uploaded file (if present and non-empty) → upload to Vercel Blob, use that URL
 * 2. Pasted URL in `image_url` text field
 * 3. Existing `previousImageUrl` (so editing without changing the file keeps the URL)
 */
async function resolveImageUrl(
  form: FormData,
  previousImageUrl: string | null,
): Promise<string | null> {
  const file = form.get("image_file");
  if (file instanceof File && file.size > 0) {
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const blob = await put(`items/${Date.now()}-${safeName}`, file, {
      access: "public",
      addRandomSuffix: true,
    });
    return blob.url;
  }
  const pasted = textField(form, "image_url");
  if (pasted !== null) return pasted;
  return previousImageUrl;
}

export async function createItem(form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const priceTacos = intField(form, "price_tacos");
  const quantity = optionalIntField(form, "quantity");
  const redemptionInstructions = textField(form, "redemption_instructions");
  const imageUrl = await resolveImageUrl(form, null);

  await db.insert(items).values({
    name,
    description,
    imageUrl,
    priceTacos,
    quantity,
    redemptionInstructions,
  });
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function updateItem(id: string, form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const priceTacos = intField(form, "price_tacos");
  const quantity = optionalIntField(form, "quantity");
  const redemptionInstructions = textField(form, "redemption_instructions");
  const previous = await db
    .select({ imageUrl: items.imageUrl })
    .from(items)
    .where(eq(items.id, id))
    .limit(1);
  const imageUrl = await resolveImageUrl(form, previous[0]?.imageUrl ?? null);

  await db
    .update(items)
    .set({
      name,
      description,
      imageUrl,
      priceTacos,
      quantity,
      redemptionInstructions,
      updatedAt: sql`now()`,
    })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function toggleItemActive(id: string, isActive: boolean) {
  await requireAdmin();
  await db
    .update(items)
    .set({ isActive, updatedAt: sql`now()` })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}
