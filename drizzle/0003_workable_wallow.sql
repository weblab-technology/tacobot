ALTER TABLE "transactions" DROP CONSTRAINT "transactions_amount_positive";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_shape_and_rule";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_valid" CHECK ((
        ("transactions"."type" IN ('give','redeem','reversal') AND "transactions"."amount" > 0)
        OR
        ("transactions"."type" = 'grant' AND "transactions"."amount" <> 0)
      ));--> statement-breakpoint
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
        OR
        ("transactions"."type" = 'grant'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."admin_user_id" IS NOT NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."reversed_transaction_id" IS NULL)
      ));