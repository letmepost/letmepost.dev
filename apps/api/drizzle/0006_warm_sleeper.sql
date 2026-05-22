CREATE TYPE "public"."billing_status" AS ENUM('free', 'active', 'past_due', 'delinquent', 'cancelled', 'expired', 'paused');--> statement-breakpoint
CREATE TYPE "public"."billing_tier" AS ENUM('free', 'pro', 'business', 'enterprise', 'self_host');--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"tier" "billing_tier" DEFAULT 'free' NOT NULL,
	"status" "billing_status" DEFAULT 'free' NOT NULL,
	"ls_customer_id" text,
	"ls_subscription_id" text,
	"ls_variant_id" text,
	"ls_product_id" text,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"grandfathered_until" timestamp with time zone,
	"payment_failed_at" timestamp with time zone,
	"payment_recovered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_usage" (
	"organization_id" uuid NOT NULL,
	"period" varchar(7) NOT NULL,
	"posts_count" integer DEFAULT 0 NOT NULL,
	"warning_80_sent_at" timestamp with time zone,
	"exceeded_sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_usage_organization_id_period_pk" PRIMARY KEY("organization_id","period")
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ls_event_id" text NOT NULL,
	"ls_event_name" text NOT NULL,
	"organization_id" uuid,
	"ls_subscription_id" text,
	"payload" jsonb,
	"signature_valid" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_usage" ADD CONSTRAINT "billing_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_org_unique" ON "billing_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_ls_subscription_unique" ON "billing_subscriptions" USING btree ("ls_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_ls_event_id_unique" ON "billing_events" USING btree ("ls_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_organization_id_idx" ON "billing_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "billing_events_ls_subscription_id_idx" ON "billing_events" USING btree ("ls_subscription_id");