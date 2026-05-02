import { db } from "@/lib/db/client";
import { config } from "@/lib/config";
import { resetDailyAllowance } from "./reset";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  if (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const updated = await resetDailyAllowance(db, config.taco.dailyAllowance);
  return Response.json({ updated });
}

export async function GET(req: Request) {
  // Vercel Cron sends GET by default in some configurations.
  return POST(req);
}
