ALTER TABLE "items" ADD COLUMN "quantity" integer;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "redemption_instructions" text;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_quantity_positive" CHECK ("items"."quantity" IS NULL OR "items"."quantity" > 0);