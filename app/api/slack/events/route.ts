import { receiver } from "@/lib/slack/bolt";
// Side-effect import will register handlers (added in later phases):
import "@/lib/slack/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return receiver.handle(req);
}
