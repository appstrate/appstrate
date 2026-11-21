CREATE TABLE "org_package_offers" (
	"org_id" uuid NOT NULL,
	"package_id" text NOT NULL,
	"offered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_package_offers_org_id_package_id_pk" PRIMARY KEY("org_id","package_id")
);
--> statement-breakpoint
ALTER TABLE "space_packages" ADD COLUMN "placed_by_offer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "org_package_offers" ADD CONSTRAINT "org_package_offers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_package_offers" ADD CONSTRAINT "org_package_offers_package_id_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."packages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_package_offers" ADD CONSTRAINT "org_package_offers_offered_by_user_id_fk" FOREIGN KEY ("offered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_org_package_offers_package_id" ON "org_package_offers" USING btree ("package_id");--> statement-breakpoint
CREATE INDEX "idx_org_package_offers_offered_by" ON "org_package_offers" USING btree ("offered_by");