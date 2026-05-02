import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
    receivedNonNegative: check("users_received_total_nonneg", sql`${t.receivedTotal} >= 0`),
    balanceNonNegative: check("users_balance_nonneg", sql`${t.balance} >= 0`),
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
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pricePositive: check("items_price_positive", sql`${t.priceTacos} > 0`),
    activeNameUnique: uniqueIndex("items_active_name_unique")
      .on(sql`lower(${t.name})`)
      .where(sql`${t.isActive}`),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
