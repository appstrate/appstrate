-- Rename organization_members → org_members (consistent with org_* prefix convention)
ALTER TABLE "organization_members" RENAME TO "org_members";
ALTER INDEX "idx_organization_members_user_id" RENAME TO "idx_org_members_user_id";

-- Rename webhooks.flow_id → package_id (legacy column name, no production data)
ALTER TABLE "webhooks" RENAME COLUMN "flow_id" TO "package_id";
