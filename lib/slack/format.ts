import type { GivePlan } from "./give";

export function overAllowanceMessage(demand: number, remaining: number): string {
  return `🌮 You've only got ${remaining} taco${remaining === 1 ? "" : "s"} left today; that would need ${demand}. Try again tomorrow.`;
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
