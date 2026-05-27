CREATE TYPE "public"."email_suppression_reason" AS ENUM('complained', 'bounced_hard', 'manual_unsubscribe');--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" "email_suppression_reason" NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
