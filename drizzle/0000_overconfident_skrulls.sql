CREATE TABLE IF NOT EXISTS "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"image_url" text,
	"price_tacos" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_price_positive" CHECK ("items"."price_tacos" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"to_user_id" text NOT NULL,
	"from_user_id" text,
	"admin_user_id" text,
	"item_id" uuid,
	"amount" integer NOT NULL,
	"reason" text,
	"slack_event_id" text,
	"slack_channel_id" text,
	"slack_message_ts" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_slack_event_id_unique" UNIQUE("slack_event_id"),
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount" > 0),
	CONSTRAINT "transactions_shape_and_rule" CHECK ((
        ("transactions"."type" = 'give'
          AND "transactions"."from_user_id" IS NOT NULL
          AND "transactions"."admin_user_id" IS NULL
          AND "transactions"."item_id" IS NULL
          AND "transactions"."from_user_id" <> "transactions"."to_user_id")
        OR
        ("transactions"."type" = 'redeem'
          AND "transactions"."from_user_id" IS NULL
          AND "transactions"."admin_user_id" IS NOT NULL
          AND "transactions"."item_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"daily_remaining" integer NOT NULL,
	"received_total" integer DEFAULT 0 NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_daily_remaining_nonneg" CHECK ("users"."daily_remaining" >= 0),
	CONSTRAINT "users_received_total_nonneg" CHECK ("users"."received_total" >= 0),
	CONSTRAINT "users_balance_nonneg" CHECK ("users"."balance" >= 0),
	CONSTRAINT "users_balance_le_received" CHECK ("users"."balance" <= "users"."received_total")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_admin_user_id_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "transactions" ADD CONSTRAINT "transactions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "items_active_name_unique" ON "items" USING btree (lower("name")) WHERE "items"."is_active";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_to_created" ON "transactions" USING btree ("to_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_from_created" ON "transactions" USING btree ("from_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_type_created" ON "transactions" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transactions_admin_created" ON "transactions" USING btree ("admin_user_id","created_at");