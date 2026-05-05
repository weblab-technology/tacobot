import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { db } from "@/lib/db/client";
import { ensureUserExists, upsertUser } from "@/lib/db/queries";
import { config } from "@/lib/config";
import { decide, validate, type GiverState } from "../give";
import { executeGive } from "../execute";
import { executeMessageReversal, type ReversedItem } from "../reverse";
import { countTacos, findUserIds } from "../parser";
import { getBotUserId } from "../botUserId";
import { resolveUserName } from "../userInfo";
import {
  giveSuccessGiverMessage,
  giveSuccessRecipientMessage,
  messageDeletedGiverMessage,
  messageDeletedRecipientMessage,
  overAllowanceMessage,
} from "../format";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";

export function registerMessageHandler(app: App) {
  app.event("message", async ({ event, client }) => {
    // Bolt types `event` as a union; narrow defensively. We only handle
    // public-channel typed messages here. Commands / DMs go through
    // their own handlers in later tasks.
    if (event.subtype === "message_deleted") {
      // Reverse every give tied to the deleted message (text-mention gives
      // and :taco: reactions both record (channel, message_ts), so a single
      // lookup catches both). The DB lookup itself bounds the work — no
      // allowlist check; if no rows match this is a cheap no-op.
      const previousTs =
        "previous_message" in event && event.previous_message
          ? event.previous_message.ts
          : undefined;
      if (!previousTs) return;
      const result = await executeMessageReversal(db, {
        channelId: event.channel,
        messageTs: previousTs,
        dailyAllowance: config.taco.dailyAllowance,
      });
      if (result.kind === "ok") {
        await notifyMessageReversal(client, event.channel, result.reversed);
      }
      return;
    }
    if (event.subtype === "message_changed") return;
    if (event.subtype === "bot_message") return;
    if (event.channel_type !== "channel") return;

    const text = "text" in event ? (event.text ?? "") : "";
    const tacoCount = countTacos(text, config.taco.acceptedEmojis);
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
        text: overAllowanceMessage(v.demand, v.remaining, config.taco.confirmationEmojiName),
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
        text: overAllowanceMessage(
          plan.giverDecrement,
          giver.dailyRemaining,
          config.taco.confirmationEmojiName,
        ),
      });
      return;
    }

    if (result.kind === "ok") {
      // Visual ack; failure is non-fatal. Off by default — see TACO_REACT_ON_GIVE.
      if (config.taco.reactOnGive) {
        try {
          await client.reactions.add({
            channel: channelId,
            timestamp: event.ts,
            name: config.taco.confirmationEmojiName,
          });
        } catch (err) {
          console.warn("[reactions.add] failed", err);
        }
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

async function notifyMessageReversal(
  client: WebClient,
  channelId: string,
  reversed: ReversedItem[],
) {
  // One DM per giver listing their now-reversed gifts; one DM per recipient
  // grouped by giver so a recipient who got multiple tacos from the same
  // sender sees one message instead of many.
  const byGiver = new Map<string, ReversedItem[]>();
  const byRecipient = new Map<string, Map<string, number>>(); // recipient → giver → amount
  for (const item of reversed) {
    const list = byGiver.get(item.giverId) ?? [];
    list.push(item);
    byGiver.set(item.giverId, list);

    const inner = byRecipient.get(item.recipientId) ?? new Map<string, number>();
    inner.set(item.giverId, (inner.get(item.giverId) ?? 0) + item.amount);
    byRecipient.set(item.recipientId, inner);
  }

  for (const [giverId, items] of byGiver) {
    try {
      await client.chat.postMessage({
        channel: giverId,
        text: messageDeletedGiverMessage(items, channelId, config.taco.confirmationEmojiName),
      });
    } catch (err) {
      console.warn("[chat.postMessage reversal giver] failed", err);
    }
  }

  for (const [recipientId, perGiver] of byRecipient) {
    for (const [giverId, amount] of perGiver) {
      try {
        await client.chat.postMessage({
          channel: recipientId,
          text: messageDeletedRecipientMessage(
            giverId,
            amount,
            channelId,
            config.taco.confirmationEmojiName,
          ),
        });
      } catch (err) {
        console.warn("[chat.postMessage reversal recipient] failed", err);
      }
    }
  }
}
