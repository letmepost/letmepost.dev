ALTER TABLE "posts" DROP CONSTRAINT "posts_account_id_platform_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "posts" ALTER COLUMN "account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE set null ON UPDATE no action;