"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { auth } from "@/lib/auth";
import { redeem } from "@/lib/admin/redeem";

async function requireAdminId(): Promise<string> {
  const s = await auth();
  const slackId = (s as { slackUserId?: string } | null)?.slackUserId;
  if (!slackId) throw new Error("unauthorized");
  return slackId;
}

export async function deductTacos(formData: FormData) {
  const adminId = await requireAdminId();
  const employeeId = String(formData.get("employee_id") ?? "");
  const itemId = String(formData.get("item_id") ?? "");
  const amountRaw = String(formData.get("amount") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!employeeId || !itemId) throw new Error("missing fields");
  const amount = Number.parseInt(amountRaw, 10);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("amount must be positive");

  const result = await redeem(db, { employeeId, itemId, amount, adminId, reason });
  if (result.kind === "insufficient") {
    throw new Error("Employee has insufficient balance for that amount");
  }
  revalidatePath("/admin/users");
}
