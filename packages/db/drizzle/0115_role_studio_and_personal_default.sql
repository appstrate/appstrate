-- Two shapes every existing row already satisfies, so nothing is rewritten (RBAC spec §3.3, §3.6):
-- `space_roles.shows_studio` is a display attribute of a custom role (constant default true = as
-- before), and a CUSTOM personal-space default gets a column under an FK beside the preset one in
-- `org_settings.personal_space_role` (NULL on every existing row: none is custom on main; the key
-- holds `admin` or `operator` there, both presets).
ALTER TABLE "organizations" ADD COLUMN "personal_space_role_id" text;--> statement-breakpoint
ALTER TABLE "space_roles" ADD COLUMN "shows_studio" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_space_roles_id_org_id" ON "space_roles" USING btree ("id","org_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_space_role_fk" FOREIGN KEY ("personal_space_role_id","id") REFERENCES "public"."space_roles"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_organizations_personal_space_role_id" ON "organizations" USING btree ("personal_space_role_id");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_space_role_one_shape" CHECK (personal_space_role_id IS NULL OR NOT (org_settings ? 'personal_space_role'));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_personal_space_role_preset" CHECK (NOT (org_settings ? 'personal_space_role') OR COALESCE(org_settings ->> 'personal_space_role' IN ('admin', 'builder', 'operator', 'runner', 'viewer'), false));
