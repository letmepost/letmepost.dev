CREATE TABLE "impersonation_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"target_user_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"reason" text,
	"requested_ip" text,
	"requested_user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"consumed_ip" text,
	"session_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "impersonation_grants" ADD CONSTRAINT "impersonation_grants_target_user_id_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "impersonation_grants_token_hash_unique" ON "impersonation_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "impersonation_grants_target_idx" ON "impersonation_grants" USING btree ("target_user_id");