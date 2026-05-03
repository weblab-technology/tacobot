import type { App } from "@slack/bolt";
import { db } from "@/lib/db/client";
import { ensureUserExists, upsertUser } from "@/lib/db/queries";
import { config } from "@/lib/config";
import { decide, validate, type GiverState } from "../give";
import { executeGive } from "../execute";
import { countTacos, findUserIds } from "../parser";
import { getBotUserId } from "../botUserId";
import { resolveUserName } from "../userInfo";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  overAllowanceMessage,
} from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export function registerMessageHandler(app: App) {
  app.event("message", async ({ event, client }) => {
    // Bolt types `event` as a union; narrow defensively. We only handle
    // public-channel typed messages here. Commands / DMs go through
    // their own handlers in later tasks.
    if (event.subtype === "message_changed" || event.subtype === "message_deleted") {
      return;
    }
    if (event.subtype === "bot_message") return;
    if (event.channel_type !== "channel") return;

    const text = "text" in event ? (event.text ?? "") : "";
    const tacoCount = countTacos(text);
    if (tacoCount === 0) return;

    const channelId = event.channel;
    if (!config.taco.channels.includes(channelId)) return;

    const giverId = "user" in event ? event.user : undefined;
    if (!giverId) return;

    const botId = await getBotUserId();
    const recipientIds = findUserIds(text).filter((u) => u !== botId);
    if (recipientIds.length === 0) return;

    // Lazy-ensure rows exist for giver and recipients (placeholder name=id),
    // then refresh names from Slack when available so we never overwrite a
    // good display name with the raw user ID.
    const allIds = [giverId, ...recipientIds];
    for (const id of allIds) {
      await ensureUserExists(db, { id, dailyAllowance: config.taco.dailyAllowance });
    }
    const resolvedNames = await Promise.all(allIds.map((id) => resolveUserName(id)));
    for (let i = 0; i < allIds.length; i++) {
      const name = resolvedNames[i];
      if (name) {
        await upsertUser(db, { id: allIds[i], name, dailyAllowance: config.taco.dailyAllowance });
      }
    }

    const [giverRow] = await db.select().from(users).where(eq(users.id, giverId));
    if (!giverRow) return; // shouldn't happen after upsert, but defensively
    const giver: GiverState = {
      id: giverRow.id,
      isActive: giverRow.isActive,
      dailyRemaining: giverRow.dailyRemaining,
    };

    const v = validate(
      {
        giverId,
        recipientIds,
        tacoCount,
        channelId,
        slackEventId: event.event_ts,
        channelTs: event.ts,
      },
      giver,
      { channels: config.taco.channels, dailyAllowance: config.taco.dailyAllowance },
    );

    if (v.kind === "ignore") return;
    if (v.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: channelId,
        user: giverId,
        text: overAllowanceMessage(v.demand, v.remaining),
      });
      return;
    }

    const plan = decide({
      giverId,
      recipients: v.recipients,
      perRecipient: v.perRecipient,
      totalDemand: v.totalDemand,
      channelId,
      channelTs: event.ts,
      envelopeEventId: event.event_ts,
      reason: text,
    });

    const result = await executeGive(db, plan);
    if (result.kind === "over_allowance") {
      await client.chat.postEphemeral({
        channel: channelId,
        user: giverId,
        text: overAllowanceMessage(plan.giverDecrement, giver.dailyRemaining),
      });
      return;
    }

    if (result.kind === "ok") {
      // Visual ack; failure is non-fatal.
      try {
        await client.reactions.add({
          channel: channelId,
          timestamp: event.ts,
          name: "taco",
        });
      } catch (err) {
        console.warn("[reactions.add] failed", err);
      }

      const remainingAfter = giver.dailyRemaining - plan.giverDecrement;

      try {
        await client.chat.postMessage({
          channel: giverId,
          text: giveSuccessGiverMessage(plan, remainingAfter),
        });
      } catch (err) {
        console.warn("[chat.postMessage giver] failed", err);
      }

      for (const t of plan.transactions) {
        try {
          await client.chat.postMessage({
            channel: t.toUserId,
            text: giveSuccessRecipientMessage(giverId, t.amount, channelId),
          });
        } catch (err) {
          console.warn("[chat.postMessage recipient] failed", err);
        }
      }
    }
  });
}
