import { getReceiver } from "@/lib/slack/bolt";
import { registerAllHandlers } from "@/lib/slack/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  registerAllHandlers();
  return getReceiver().handle(req);
}
