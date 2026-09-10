-- `package_shares` — a package's AUDIENCE, one row per space it is offered to
-- (RBAC spec §6.10).
--
-- WHY A SECOND TABLE. `space_packages` is the INSTALLATION: it carries the
-- version pin, the per-space model/proxy, the input defaults, and it is what
-- every execution path reads. A package runs with the RECIPIENT's credentials,
-- so activating one has to be the recipient's own act — and an "offered but not
-- accepted" state carried on `space_packages` would have had to be filtered at
-- each of that table's readers, where one miss runs a package nobody consented
-- to. Offered and activated are therefore two tables and two acts: sharing
-- writes here, accepting writes there, revoking deletes both in one
-- transaction.
--
-- A row here grants READ and nothing else: the metadata a recipient needs to
-- decide, plus the "add to my space" affordance. Nothing else in the codebase
-- reads this table — not the runner, not the pin resolver, not the credential
-- resolver.
--
-- `ON DELETE CASCADE` on both halves: an audience entry is meaningless without
-- its package or its space, and neither deletion loses access that was not
-- already gone. `shared_by` is `SET NULL` — the sharer leaving the organization
-- must not keep the audience alive as a foreign-key obstacle, and the audit
-- event records who shared it.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2), and a brand-new table, so
-- there is nothing to backfill and no operator script.
--
-- ROLLBACK: safe. A previous build never reads the table; the rows it leaves
-- behind are inert audience entries.

CREATE TABLE "package_shares" (
	"package_id" text NOT NULL,
	"space_id" text NOT NULL,
	"shared_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "package_shares_package_id_space_id_pk" PRIMARY KEY("package_id","space_id")
);
--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "package_shares" ADD CONSTRAINT "package_shares_shared_by_user_id_fk" FOREIGN KEY ("shared_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_package_shares_space_id" ON "package_shares" USING btree ("space_id");--> statement-breakpoint
CREATE INDEX "idx_package_shares_shared_by" ON "package_shares" USING btree ("shared_by");