import type { GivePlan } from "./give";
import type { ReversedItem } from "./reverse";

export function overAllowanceMessage(
  demand: number,
  remaining: number,
  emojiName: string,
): string {
  return `:${emojiName}: You've only got ${remaining} taco${remaining === 1 ? "" : "s"} left today; that would need ${demand}. Try again tomorrow.`;
}

export function giveSuccessGiverMessage(plan: GivePlan, remainingAfter: number): string {
  const lines = plan.transactions.map(
    (t) => `<@${t.toUserId}> received ${t.amount} taco${t.amount === 1 ? "" : "s"} from you.`,
  );
  lines.push(
    `You have ${remainingAfter} taco${remainingAfter === 1 ? "" : "s"} left to give out today.`,
  );
  return lines.join("\n");
}

export function giveSuccessRecipientMessage(
  giverId: string,
  amount: number,
  channelId: string,
): string {
  return `You received ${amount} taco${amount === 1 ? "" : "s"} from <@${giverId}> in <#${channelId}>.`;
}

// Neutral wording: a deleter's text-mention give and a reactor's reaction-give
// can both end up reversed by the same `message_deleted` event, so the DM has
// to read correctly for both audiences (the actor of the original give isn't
// always the deleter).
export function messageDeletedGiverMessage(
  items: ReversedItem[],
  channelId: string,
  emojiName: string,
): string {
  const lines = items.map(
    (i) => `<@${i.recipientId}> lost ${i.amount} taco${i.amount === 1 ? "" : "s"}.`,
  );
  return [
    `:${emojiName}: A message in <#${channelId}> was deleted; the tacos you gave in connection with it were taken back:`,
    ...lines,
  ].join("\n");
}

export function messageDeletedRecipientMessage(
  giverId: string,
  amount: number,
  channelId: string,
  emojiName: string,
): string {
  return `:${emojiName}: A message in <#${channelId}> was deleted; ${amount} taco${amount === 1 ? "" : "s"} you received from <@${giverId}> ${amount === 1 ? "was" : "were"} taken back.`;
}

export function reactionRemovedReactorMessage(
  items: { recipientId: string; amount: number }[],
  channelId: string,
  emojiName: string,
): string {
  const emoji = `:${emojiName}:`;
  if (items.length === 1) {
    const { recipientId, amount } = items[0];
    return `${emoji} You removed your ${emoji} reaction in <#${channelId}>; ${amount} taco${amount === 1 ? "" : "s"} ${amount === 1 ? "was" : "were"} taken back from <@${recipientId}>.`;
  }
  const lines = items.map(
    (i) => `<@${i.recipientId}> lost ${i.amount} taco${i.amount === 1 ? "" : "s"}.`,
  );
  return [
    `${emoji} You removed your ${emoji} reaction in <#${channelId}>; reversed:`,
    ...lines,
  ].join("\n");
}

// Recipient-facing DM for an admin balance adjustment. Branches on sign:
// positive grants get warm onboarding wording with a shop link; negative
// grants get neutral "adjusted" wording. Optional `reason` is appended on a
// new line.
export function grantNotificationMessage(
  amount: number,
  reason: string | null,
  shopUrl: string,
  emojiName: string,
): string {
  const reasonLine = reason ? `\nNote: ${reason}` : "";
  if (amount > 0) {
    return `:${emojiName}: You received ${amount} taco${amount === 1 ? "" : "s"} from an admin to spend in the shop: ${shopUrl}${reasonLine}`;
  }
  const abs = Math.abs(amount);
  return `:${emojiName}: An admin adjusted your taco balance by ${amount} taco${abs === 1 ? "" : "s"}.${reasonLine}`;
}

export function reactionRemovedRecipientMessage(
  reactorId: string,
  amount: number,
  channelId: string,
  emojiName: string,
): string {
  const emoji = `:${emojiName}:`;
  return `${emoji} <@${reactorId}> removed their ${emoji} reaction in <#${channelId}>; ${amount} taco${amount === 1 ? "" : "s"} you received from them ${amount === 1 ? "was" : "were"} taken back.`;
}
