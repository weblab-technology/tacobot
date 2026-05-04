import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),                                  // Slack user ID, "U..."
    name: text("name").notNull(),
    dailyRemaining: integer("daily_remaining").notNull(),
    receivedTotal: integer("received_total").notNull().default(0),
    balance: integer("balance").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dailyNonNegative: check("users_daily_remaining_nonneg", sql`${t.dailyRemaining} >= 0`),
    // `received_total` and `balance` may go negative after a reversal of a give
    // whose recipient already redeemed: the give that funded the redemption is
    // undone, but the redemption itself stays. The relationship `balance <=
    // received_total` is preserved because reversals decrement both by the
    // same amount.
    balanceLeReceived: check(
      "users_balance_le_received",
      sql`${t.balance} <= ${t.receivedTotal}`,
    ),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    priceTacos: integer("price_tacos").notNull(),
    quantity: integer("quantity"),
    redemptionInstructions: text("redemption_instructions"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pricePositive: check("items_price_positive", sql`${t.priceTacos} > 0`),
    quantityPositive: check(
      "items_quantity_positive",
      sql`${t.quantity} IS NULL OR ${t.quantity} > 0`,
    ),
    activeNameUnique: uniqueIndex("items_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.isActive}`),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;

export const transactionType = ["give", "redeem", "reversal"] as const;
export type TransactionType = (typeof transactionType)[number];

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type", { enum: transactionType }).notNull(),
    toUserId: text("to_user_id").notNull().references(() => users.id),
    fromUserId: text("from_user_id").references(() => users.id),
    adminUserId: text("admin_user_id").references(() => users.id),
    itemId: uuid("item_id").references(() => items.id),
    amount: integer("amount").notNull(),
    reason: text("reason"),
    slackEventId: text("slack_event_id").unique(),
    slackChannelId: text("slack_channel_id"),
    slackMessageTs: text("slack_message_ts"),
    // For type='reversal' rows only: the give being reversed. UNIQUE so any
    // single give can only be compensated once, even under retries.
    reversedTransactionId: uuid("reversed_transaction_id").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    amountPositive: check("transactions_amount_positive", sql`${t.amount} > 0`),
    shapeAndRule: check(
      "transactions_shape_and_rule",
      sql`(
        (${t.type} = 'give'
          AND ${t.fromUserId} IS NOT NULL
          AND ${t.adminUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.reversedTransactionId} IS NULL
          AND ${t.fromUserId} <> ${t.toUserId})
        OR
        (${t.type} = 'redeem'
          AND ${t.fromUserId} IS NULL
          AND ${t.adminUserId} IS NOT NULL
          AND ${t.itemId} IS NOT NULL
          AND ${t.reversedTransactionId} IS NULL)
        OR
        (${t.type} = 'reversal'
          AND ${t.fromUserId} IS NULL
          AND ${t.adminUserId} IS NULL
          AND ${t.itemId} IS NULL
          AND ${t.reversedTransactionId} IS NOT NULL)
      )`,
    ),
    toCreatedIdx: index("transactions_to_created").on(t.toUserId, t.createdAt),
    fromCreatedIdx: index("transactions_from_created").on(t.fromUserId, t.createdAt),
    typeCreatedIdx: index("transactions_type_created").on(t.type, t.createdAt),
    adminCreatedIdx: index("transactions_admin_created").on(t.adminUserId, t.createdAt),
    channelMsgIdx: index("transactions_channel_message").on(
      t.slackChannelId,
      t.slackMessageTs,
    ),
  }),
);

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
