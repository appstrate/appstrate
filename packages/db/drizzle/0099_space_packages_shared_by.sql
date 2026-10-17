-- 0099 — one table answers "is this package placed here?" (#2045). `space_packages` gains
-- `shared_by` (who placed the package outside its home; SET NULL with the account) and `enabled`
-- loses its DEFAULT, so every writer states whether the row it creates is on. Pure DDL: the
-- `package_shares` rows are folded into `space_packages` by `scripts/migration/0046`, which
-- needs this column, so the table stays until the follow-up release drops it (drizzle applies the
-- batch in one transaction and the scripts run after it — nothing can run between the two).
--
-- COST: ADD COLUMN without a default and DROP DEFAULT are catalog-only; the index build holds
-- SHARE on `space_packages` (one row per placement) for its duration. Fenced like 0059/0070 and
-- released at the foot, so the ceilings do not govern the migrations that follow in the batch.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '60s';--> statement-breakpoint
ALTER TABLE "space_packages" ALTER COLUMN "enabled" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "space_packages" ADD COLUMN "shared_by" text;--> statement-breakpoint
ALTER TABLE "space_packages" ADD CONSTRAINT "space_packages_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_space_packages_shared_by" ON "space_packages" USING btree ("shared_by");--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
