ALTER TABLE "transactions" DROP CONSTRAINT "transactions_shape_and_rule";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_received_total_nonneg";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_balance_nonneg";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reversed_transaction_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_channel_message" ON "transactions" USING btree ("slack_channel_id","slack_message_ts");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_reversed_transaction_id_unique" UNIQUE("reversed_transaction_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_shape_and_rule" CHECK ((
        ("transactions"."type" = 'give'
          AND "transactions"."from_user_id" IS NOT NULL
          AND "transactions"."admin_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NULL
          AND "transactions"."from_user_id" <> "transactions"."to_user_id")
        OR
        ("transactions"."type" = 'redeem'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."admin_user_id" IS NOT NULL
          AND "transactions"."item_id" IS NOT NULL
          AND "transactions"."reversed_transaction_id" IS NULL)
        OR
        ("transactions"."type" = 'reversal'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."admin_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NOT NULL)
      ));