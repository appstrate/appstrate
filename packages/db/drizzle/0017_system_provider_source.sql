-- Migration: Add "system" to package_source enum
-- System providers have registry-grade integrity (packageVersions, ZIP artifacts, SRI hashes).

ALTER TYPE "package_source" ADD VALUE IF NOT EXISTS 'system';
