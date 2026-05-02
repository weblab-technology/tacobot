"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";
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

function textField(form: FormData, key: string, opts: { required?: boolean } = {}): string | null {
  const raw = form.get(key);
  if (typeof raw !== "string" || raw.trim() === "") {
    if (opts.required) throw new Error(`${key} required`);
    return null;
  }
  return raw.trim();
}

export async function createItem(form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const imageUrl = textField(form, "image_url");
  const priceTacos = intField(form, "price_tacos");
  await db.insert(items).values({ name, description, imageUrl, priceTacos });
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function updateItem(id: string, form: FormData) {
  await requireAdmin();
  const name = textField(form, "name", { required: true })!;
  const description = textField(form, "description");
  const imageUrl = textField(form, "image_url");
  const priceTacos = intField(form, "price_tacos");
  await db.update(items)
    .set({ name, description, imageUrl, priceTacos, updatedAt: sql`now()` })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}

export async function toggleItemActive(id: string, isActive: boolean) {
  await requireAdmin();
  await db.update(items)
    .set({ isActive, updatedAt: sql`now()` })
    .where(eq(items.id, id));
  revalidatePath("/admin/items");
  revalidatePath("/shop");
}
