export type Intent = {
  giverId: string;
  recipientIds: string[];
  tacoCount: number;
  channelId: string;
  slackEventId: string;
  channelTs: string;
};

export type GiverState = {
  id: string;
  isActive: boolean;
  dailyRemaining: number;
};

export type ValidateConfig = {
  channels: string[];
  dailyAllowance: number;
};

export type ValidateResult =
  | {
      kind: "ok";
      recipients: string[];
      totalDemand: number;
      perRecipient: number;
    }
  | { kind: "ignore"; reason: string }
  | { kind: "over_allowance"; demand: number; remaining: number };

export function validate(
  intent: Intent,
  giver: GiverState,
  config: ValidateConfig,
): ValidateResult {
  if (!config.channels.includes(intent.channelId)) {
    return { kind: "ignore", reason: "channel_not_allowlisted" };
  }
  if (!giver.isActive) {
    return { kind: "ignore", reason: "giver_inactive" };
  }
  if (intent.tacoCount <= 0) {
    return { kind: "ignore", reason: "no_tacos" };
  }
  const recipients = [...new Set(intent.recipientIds)]
    .filter((r) => r !== intent.giverId)
    .sort();
  if (recipients.length === 0) {
    return { kind: "ignore", reason: "no_recipients" };
  }
  const totalDemand = intent.tacoCount * recipients.length;
  if (totalDemand > giver.dailyRemaining) {
    return { kind: "over_allowance", demand: totalDemand, remaining: giver.dailyRemaining };
  }
  return {
    kind: "ok",
    recipients,
    totalDemand,
    perRecipient: intent.tacoCount,
  };
}

export type DecideInput = {
  giverId: string;
  recipients: string[];
  perRecipient: number;
  totalDemand: number;
  channelId: string;
  channelTs: string;
  envelopeEventId: string;
  reason?: string | null;
};

export type PlannedTransaction = {
  toUserId: string;
  fromUserId: string;
  amount: number;
  slackEventId: string;
  slackChannelId: string;
  slackMessageTs: string;
  reason: string | null;
};

export type GivePlan = {
  giverId: string;
  giverDecrement: number;
  transactions: PlannedTransaction[];
};

export function decide(input: DecideInput): GivePlan {
  const transactions: PlannedTransaction[] = input.recipients.map((rid, idx) => ({
    toUserId: rid,
    fromUserId: input.giverId,
    amount: input.perRecipient,
    slackEventId: `${input.envelopeEventId}-${idx}`,
    slackChannelId: input.channelId,
    slackMessageTs: input.channelTs,
    reason: input.reason ?? null,
  }));
  return {
    giverId: input.giverId,
    giverDecrement: input.totalDemand,
    transactions,
  };
}
