-- Rename service_id → provider_id in package_admin_connections
ALTER TABLE "package_admin_connections" RENAME COLUMN "service_id" TO "provider_id";
